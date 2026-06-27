import type {
  CipherscanAddressResponse,
  CipherscanFlow,
  CipherscanFlowsResponse,
  CipherscanTxDetail,
  PoolMode,
} from "./cipherscan"
import {
  RateLimiter,
  addressDetailUrl,
  fetchJson,
  fetchMany,
  flowsUrl,
  listUrl,
  txDetailUrl,
} from "./cipherscan"
import type {
  PostUnshieldSummary,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "@/components/api-types"
import {
  ACTIVATION_BLOCK,
  ACTIVATION_TIME,
  COMPLETE_RESPONSE_CACHE_TTL_SECONDS,
  DEFAULT_LIMIT,
  INVENTORY_PAGE_SIZE,
  INVENTORY_REFRESH_MS,
  INVENTORY_TTL_SECONDS,
  MAX_LIMIT,
  PERIODS,
  SORTS,
  TRACE_RETRY_BACKOFF_MS,
  TRACE_STORAGE_TTL_SECONDS,
  WARMING_RESPONSE_CACHE_TTL_SECONDS,
  type CachedTrace,
  type FlowInventory,
  type KVLike,
  addressTxToEvent,
  fetchLiveZecPrice,
  flowIdentity,
  flowTimeMs,
  inventoryCovers,
  inventoryKey,
  isCachedTraceStale,
  isOutgoingTx,
  mergeTraceEvidence,
  parseInventory,
  parseProgress,
  parseTraceBlob,
  periodCutoff,
  progressKey,
  responseCacheKey,
  reshieldType,
  round,
  secondsToIso,
  shouldPreserveCachedTrace,
  staleResponseCacheKey,
  summarizeTraces,
  touchesShieldedPool,
  traceBlobKey,
  zatoshiToZec,
} from "./shared"

export const CLASSIFICATION_BATCH_SIZE = 75
const RATE_LIMIT_CAPACITY = 75
const RATE_LIMIT_REFILL_MS = 60_000
const ADDRESS_FETCH_CONCURRENCY = 8
const TX_FETCH_CONCURRENCY = 8
const PRIORITY_TRACE_SCAN_LIMIT = 600

async function loadInventory(
  kv: KVLike,
  pool: PoolMode
): Promise<FlowInventory | null> {
  // `all` has no inventory of its own — it is the union of orchard + sapling,
  // which the cron refreshes every minute. Merging here avoids maintaining a
  // separate ~1.3MB `all` inventory that would have to be read and rewritten
  // on every SWR rebuild (which was timing out the request-path build).
  if (pool === "all") {
    const [orchard, sapling] = await Promise.all([
      loadInventory(kv, "orchard"),
      loadInventory(kv, "sapling"),
    ])
    if (!orchard && !sapling) return null
    const flows = [
      ...(orchard?.flows ?? []),
      ...(sapling?.flows ?? []),
    ]
    const deduped = [
      ...new Map(flows.map((f) => [flowIdentity(f), f])).values(),
    ].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))
    const base = orchard ?? sapling!
    return {
      flows: deduped,
      fetchedAt: Math.max(orchard?.fetchedAt ?? 0, sapling?.fetchedAt ?? 0),
      headFetchedAt: Math.max(
        orchard?.headFetchedAt ?? 0,
        sapling?.headFetchedAt ?? 0
      ),
      complete: Boolean(
        (orchard?.complete ?? false) && (sapling?.complete ?? false)
      ),
      nextCursor: null,
      nextCursorId: null,
      source: "merged:orchard+sapling",
    }
  }
  return parseInventory(await kv.get(inventoryKey(pool)))
}

async function saveInventory(
  kv: KVLike,
  pool: PoolMode,
  inventory: FlowInventory
): Promise<void> {
  await kv.put(inventoryKey(pool), JSON.stringify(inventory), {
    expirationTtl: INVENTORY_TTL_SECONDS,
  })
}

/** Load the trace blob for a pool into a mutable identity map.
 *  `all` has no blob of its own (the cron only classifies orchard/sapling);
 *  it merges the two, mirroring how the old per-flow trace cache was shared
 *  across pools via flow identity. */
async function loadTraceBlob(
  kv: KVLike,
  pool: PoolMode
): Promise<Map<string, CachedTrace>> {
  if (pool === "all") {
    const [orchard, sapling] = await Promise.all([
      loadTraceBlob(kv, "orchard"),
      loadTraceBlob(kv, "sapling"),
    ])
    return new Map([...orchard, ...sapling])
  }
  return parseTraceBlob(await kv.get(traceBlobKey(pool)).catch(() => null))
}

/** Persist the whole trace blob in one write. */
async function saveTraceBlob(
  kv: KVLike,
  pool: PoolMode,
  traces: Map<string, CachedTrace>
): Promise<void> {
  const blob = JSON.stringify({
    traces: Object.fromEntries(traces),
    updatedAt: Date.now(),
  })
  await kv.put(traceBlobKey(pool), blob, {
    expirationTtl: TRACE_STORAGE_TTL_SECONDS,
  })
}

async function refreshInventoryPage(
  pool: PoolMode,
  existing: FlowInventory | null
): Promise<FlowInventory> {
  const fetchedAt = Date.now()
  const activationMs = Date.parse(ACTIVATION_TIME)
  const known = new Set((existing?.flows ?? []).map(flowIdentity))
  const cursor =
    existing && !existing.complete ? existing.nextCursor : null
  const cursorId =
    existing && !existing.complete ? existing.nextCursorId : null

  const url = listUrl(pool, INVENTORY_PAGE_SIZE, cursor, cursorId)
  const json = await fetchJson<{
    success?: boolean
    flows?: CipherscanFlow[]
    pagination?: {
      hasNext?: boolean
      nextCursor?: number
      nextCursorId?: number
    }
  }>(url)
  const rows = (json.flows ?? []).filter(
    (flow): flow is CipherscanFlow => flow.flowType === "deshield"
  )

  const collected: CipherscanFlow[] = [...(existing?.flows ?? [])]
  let complete = existing?.complete ?? false
  let nextCursor: number | null = null
  let nextCursorId: number | null = null

  if (rows.length === 0) {
    complete = true
  } else {
    for (const flow of rows) {
      const ms = flowTimeMs(flow)
      if (ms != null && ms < activationMs) {
        complete = true
        break
      }
      if (!known.has(flowIdentity(flow))) {
        collected.push(flow)
      }
    }
    if (!complete) {
      if (json.pagination?.hasNext) {
        nextCursor = json.pagination.nextCursor ?? null
        nextCursorId = json.pagination.nextCursorId ?? null
      } else {
        complete = true
      }
    }
  }

  const deduped = [
    ...new Map(collected.map((f) => [flowIdentity(f), f])).values(),
  ]
  const sorted = deduped
    .filter((flow) => {
      const ms = flowTimeMs(flow)
      return ms == null || ms >= activationMs
    })
    .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))

  return {
    flows: sorted,
    fetchedAt,
    headFetchedAt: existing?.headFetchedAt ?? fetchedAt,
    complete,
    nextCursor,
    nextCursorId,
    source: url.toString(),
  }
}

async function refreshInventoryHead(
  pool: PoolMode,
  existing: FlowInventory
): Promise<FlowInventory> {
  const fetchedAt = Date.now()
  const url = listUrl(pool, INVENTORY_PAGE_SIZE, null, null)
  const json = await fetchJson<{
    success?: boolean
    flows?: CipherscanFlow[]
  }>(url)
  const rows = (json.flows ?? []).filter(
    (flow): flow is CipherscanFlow => flow.flowType === "deshield"
  )
  const known = new Set(existing.flows.map(flowIdentity))
  const newFlows = rows.filter(
    (flow) => !known.has(flowIdentity(flow))
  )
  const combined = [...newFlows, ...existing.flows]
  const activationMs = Date.parse(ACTIVATION_TIME)
  const deduped = [
    ...new Map(combined.map((f) => [flowIdentity(f), f])).values(),
  ]
  const sorted = deduped
    .filter((flow) => {
      const ms = flowTimeMs(flow)
      return ms == null || ms >= activationMs
    })
    .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))
  return {
    ...existing,
    flows: sorted,
    fetchedAt,
    headFetchedAt: fetchedAt,
    source: url.toString(),
  }
}

/**
 * Scan the inventory (in memory) for flows that still need classification,
 * reading cached traces from the trace blob instead of KV. Returns the batch
 * to classify plus any prior cached entries that should be preserved/merged.
 */
function findUnclassifiedBatch(
  inventory: FlowInventory,
  traceMap: Map<string, CachedTrace>,
  batchSize: number,
  prioritizeCutoffMs: number | null = null,
  recheckCachedTraces = true,
  scanStartOffset = 0
): {
  flows: CipherscanFlow[]
  previous: Map<string, CachedTrace>
  reachedEnd: boolean
  nextScanOffset: number
} {
  const flows: CipherscanFlow[] = []
  const previous = new Map<string, CachedTrace>()
  const now = Date.now()

  const processBatch = (candidates: CipherscanFlow[]) => {
    for (const flow of candidates) {
      if (flows.length >= batchSize) return
      const identity = flowIdentity(flow)
      const cached = traceMap.get(identity)
      if (cached) {
        if (cached.trace) {
          if (!recheckCachedTraces || !isCachedTraceStale(cached, now)) {
            continue
          }
          previous.set(identity, cached)
        }
        const lastAttemptAt = cached.lastAttemptAt ?? cached.checkedAt
        if (!cached.trace && now - lastAttemptAt < TRACE_RETRY_BACKOFF_MS) {
          continue
        }
        if (!cached.trace) previous.set(identity, cached)
      }
      flows.push(flow)
    }
  }

  // First pass: flows inside the prioritized window (e.g. 1h) so short-window
  // UIs see trace outcomes ASAP.
  if (prioritizeCutoffMs != null) {
    const priorityFlows = inventory.flows.filter((flow) => {
      const ms = flowTimeMs(flow)
      return ms != null && ms >= prioritizeCutoffMs
    })
    const scanLimit = Math.min(priorityFlows.length, PRIORITY_TRACE_SCAN_LIMIT)
    for (let offset = 0; offset < scanLimit; offset += 100) {
      processBatch(priorityFlows.slice(offset, offset + 100))
      if (flows.length >= batchSize) {
        return {
          flows,
          previous,
          reachedEnd: false,
          nextScanOffset: scanStartOffset,
        }
      }
    }
    return {
      flows,
      previous,
      reachedEnd: false,
      nextScanOffset: scanStartOffset,
    }
  }

  // Second pass: the rest of the inventory (or the whole thing if no priority).
  const total = inventory.flows.length
  const start = Math.max(0, Math.min(total, Math.floor(scanStartOffset)))
  const ranges: Array<[number, number]> = [
    [start, total],
    [0, start],
  ]

  for (const [rangeStart, rangeEnd] of ranges) {
    for (let offset = rangeStart; offset < rangeEnd; offset += 100) {
      const end = Math.min(rangeEnd, offset + 100)
      processBatch(inventory.flows.slice(offset, end))
      if (flows.length >= batchSize) {
        return {
          flows,
          previous,
          reachedEnd: false,
          nextScanOffset: end >= total ? 0 : end,
        }
      }
    }
  }
  return { flows, previous, reachedEnd: true, nextScanOffset: 0 }
}

function buildTrace(
  flow: CipherscanFlow,
  txDetail: CipherscanTxDetail | null,
  addressDetail: CipherscanAddressResponse | null,
  priceUsd: number | null
): PostUnshieldTrace | null {
  if (!flow.txid || typeof flow.blockHeight !== "number") return null
  const address = flow.addresses?.find(Boolean)
  if (!address) return null
  const time = secondsToIso(flow.blockTime)
  if (!time) return null
  const amountZec =
    typeof flow.amountZec === "number" && Number.isFinite(flow.amountZec)
      ? round(flow.amountZec)
      : 0

  const txTimeMs = Date.parse(time)
  const txOutput = txDetail?.outputs?.find(
    (output) => output.address === address
  )
  let outputSpent =
    typeof txOutput?.spent === "boolean" ? txOutput.spent : null
  const outputAmount = zatoshiToZec(txOutput?.value)

  const related = (addressDetail?.transactions ?? [])
    .filter((row) => row.txid && row.txid !== flow.txid)
    .map((row) => ({ row, ms: Number(row.blockTime) * 1000 }))
    .filter(({ ms }) => Number.isFinite(ms))
  const nextSpendRow = related
    .filter(({ row, ms }) => {
      if (!Number.isFinite(txTimeMs) || ms < txTimeMs) return false
      return isOutgoingTx(row)
    })
    .sort((a, b) => a.ms - b.ms)[0]?.row
  const priorShieldRow = related
    .filter(({ row, ms }) => {
      if (!Number.isFinite(txTimeMs) || ms >= txTimeMs) return false
      return (row.netChange ?? 0) < 0 && touchesShieldedPool(row)
    })
    .sort((a, b) => Number(b.row.blockTime) - Number(a.row.blockTime))[0]?.row
  const hasPriorHistory = related.some(({ ms }) =>
    Number.isFinite(txTimeMs) ? ms < txTimeMs : true
  )
  const nextSpend = nextSpendRow ? addressTxToEvent(nextSpendRow) : null
  const reshield =
    nextSpendRow && touchesShieldedPool(nextSpendRow)
      ? addressTxToEvent(nextSpendRow)
      : null
  const priorShieldSource = priorShieldRow
    ? addressTxToEvent(priorShieldRow)
    : null

  const tracedAmount = outputAmount ?? amountZec
  const nextReshieldType = reshieldType(reshield, tracedAmount)

  // Evidence synthesis. We consider an output spent if the tx detail says so
  // or if the address history shows a later outgoing (including reshield) tx.
  // We consider it unspent if the tx detail says so or if the address history
  // exists and shows no later outgoing activity.
  const spent = outputSpent === true || nextSpend != null || reshield != null
  const unspent =
    outputSpent === false || (addressDetail != null && !nextSpend && !reshield)

  let status: PostUnshieldTrace["status"] = "unknown"
  if (reshield) {
    status = "reshielded"
  } else if (spent) {
    status = "spent"
  } else if (unspent && (priorShieldSource || hasPriorHistory)) {
    status = "reused"
  } else if (unspent) {
    status = "held"
  }

  // If we have address history with no later spend, mark outputSpent false
  // even when the tx detail didn't include the specific output.
  if (!spent && unspent && outputSpent == null) {
    outputSpent = false
  }

  return {
    hash: flow.txid,
    block: flow.blockHeight,
    time,
    amountZec: round(tracedAmount),
    amountUsd: priceUsd != null ? round(tracedAmount * priceUsd, 2) : null,
    address,
    status,
    outputSpent,
    balanceZec: zatoshiToZec(addressDetail?.balance),
    totalReceivedZec: zatoshiToZec(addressDetail?.totalReceived),
    totalSentZec: zatoshiToZec(addressDetail?.totalSent),
    txCount:
      typeof addressDetail?.txCount === "number"
        ? addressDetail.txCount
        : null,
    lastSeen: secondsToIso(addressDetail?.lastSeen),
    nextSpend,
    reshield,
    reshieldType: nextReshieldType,
    priorShieldSource,
    explorerUrl: `https://cipherscan.app/tx/${flow.txid}`,
    addressUrl: `https://cipherscan.app/address/${address}`,
  }
}

/**
 * Classify a batch of flows and merge results into the in-memory trace blob.
 * No KV writes happen here — the caller persists the blob once after the run.
 * Returns the number of newly successful (non-null) traces.
 */
async function classifyBatch(
  flows: CipherscanFlow[],
  previous: Map<string, CachedTrace>,
  traceMap: Map<string, CachedTrace>,
  limiter: RateLimiter,
  priceUsd: number | null
): Promise<number> {
  if (flows.length === 0) return 0

  const unique = [
    ...new Map(flows.map((f) => [flowIdentity(f), f])).values(),
  ]

  const addressGroups = new Map<string, CipherscanFlow[]>()
  for (const flow of unique) {
    const addr = flow.addresses?.find(Boolean)
    if (!addr) continue
    if (!addressGroups.has(addr)) addressGroups.set(addr, [])
    addressGroups.get(addr)!.push(flow)
  }

  const addresses = [...addressGroups.keys()]
  const addressUrls = addresses.map(addressDetailUrl)
  const addressResults = await fetchMany<CipherscanAddressResponse>(
    addressUrls,
    ADDRESS_FETCH_CONCURRENCY,
    limiter
  )
  const addressMap = new Map<string, CipherscanAddressResponse | null>()
  addresses.forEach((addr, i) => {
    const res = addressResults[i]
    addressMap.set(addr, res instanceof Error ? null : res)
  })

  const txFlows: CipherscanFlow[] = []
  for (const flow of unique) {
    const addr = flow.addresses?.find(Boolean)
    if (!addr || !flow.txid) continue
    const detail = addressMap.get(addr)
    const txTimeMs = flowTimeMs(flow)
    const related = (detail?.transactions ?? [])
      .filter((tx) => tx.txid && tx.txid !== flow.txid)
      .map((tx) => ({ tx, ms: Number(tx.blockTime) * 1000 }))
      .filter(({ ms }) => Number.isFinite(ms))
    const nextSpend = related.find(({ tx, ms }) => {
      if (txTimeMs == null || !Number.isFinite(txTimeMs) || ms < txTimeMs)
        return false
      return isOutgoingTx(tx)
    })
    const lacksAmount =
      typeof flow.amountZec !== "number" || !Number.isFinite(flow.amountZec)
    // We need tx detail when the address history is missing (so we can't infer
    // held/spent), when the flow is missing an amount, or when a later spend
    // was detected and we want the exact output spent flag.
    if (!detail || nextSpend || lacksAmount) {
      txFlows.push(flow)
    }
  }

  const txUrls = txFlows.map((flow) => txDetailUrl(flow.txid!))
  const txResults = await fetchMany<CipherscanTxDetail>(
    txUrls,
    TX_FETCH_CONCURRENCY,
    limiter
  )
  const txMap = new Map<string, CipherscanTxDetail | null>()
  txFlows.forEach((flow, i) => {
    const res = txResults[i]
    txMap.set(flow.txid!, res instanceof Error ? null : res)
  })

  let successful = 0
  for (const flow of unique) {
    const addr = flow.addresses?.find(Boolean)
    const identity = flowIdentity(flow)
    if (!addr || !flow.txid) {
      const now = Date.now()
      traceMap.set(identity, {
        trace: null,
        checkedAt: now,
        lastAttemptAt: now,
      })
      continue
    }
    const addressDetail = addressMap.get(addr) ?? null
    const txDetail = txMap.get(flow.txid) ?? null
    const previousEntry = previous.get(identity) ?? null
    const candidate = buildTrace(flow, txDetail, addressDetail, priceUsd)

    if (!candidate) {
      const now = Date.now()
      traceMap.set(identity, {
        trace: previousEntry?.trace ?? null,
        checkedAt: previousEntry?.checkedAt ?? now,
        lastAttemptAt: now,
      })
      continue
    }

    const previousTrace = previousEntry?.trace ?? null
    const preservePrevious =
      previousTrace != null && shouldPreserveCachedTrace(previousTrace, candidate)
    const trace = preservePrevious
      ? previousTrace
      : mergeTraceEvidence(previousTrace, candidate)
    const now = Date.now()
    if (preservePrevious) {
      traceMap.set(identity, {
        trace: previousTrace,
        checkedAt: previousEntry?.checkedAt ?? now,
        lastAttemptAt: now,
      })
    } else {
      traceMap.set(identity, {
        trace,
        checkedAt: now,
        lastAttemptAt: now,
      })
    }
    successful++
  }
  return successful
}

/** Build an identity -> trace map for the given flows from the in-memory blob. */
function traceMapForFlows(
  flows: CipherscanFlow[],
  traceMap: Map<string, CachedTrace>
): Map<string, PostUnshieldTrace> {
  const map = new Map<string, PostUnshieldTrace>()
  for (const flow of flows) {
    const cached = traceMap.get(flowIdentity(flow))
    if (cached?.trace) map.set(flowIdentity(flow), cached.trace)
  }
  return map
}

async function fetchAggregatePoints(
  pool: PoolMode
): Promise<CipherscanFlowsResponse["points"]> {
  try {
    const json = await fetchJson<CipherscanFlowsResponse>(flowsUrl(pool))
    return Array.isArray(json.points) ? json.points : []
  } catch {
    return []
  }
}

function aggregateForCutoff(
  points: CipherscanFlowsResponse["points"],
  cutoffMs: number,
  priceUsd: number | null,
  source: string
): { outZec: number; outTx: number; outUsd: number | null; source: string } {
  let outZec = 0
  let outTx = 0
  for (const point of points ?? []) {
    const ms = point.date ? Date.parse(point.date) : NaN
    if (!Number.isFinite(ms) || ms < cutoffMs) continue
    outZec += typeof point.deshield === "number" ? point.deshield : 0
    outTx += typeof point.deshieldTx === "number" ? point.deshieldTx : 0
  }
  return {
    outZec: round(outZec),
    outTx,
    outUsd: priceUsd != null ? round(outZec * priceUsd, 2) : null,
    source,
  }
}

function sortWindowFlows(
  flows: CipherscanFlow[],
  sort: UnshieldingSort
): CipherscanFlow[] {
  return [...flows].sort((a, b) => {
    if (sort === "largest") {
      const diff = (b.amountZec ?? 0) - (a.amountZec ?? 0)
      if (diff !== 0) return diff
    }
    return (b.blockTime ?? 0) - (a.blockTime ?? 0)
  })
}

function buildResponseForPeriod(
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  inventory: FlowInventory,
  windowFlows: CipherscanFlow[],
  traceMap: Map<string, PostUnshieldTrace>,
  aggregate: { outZec: number; outTx: number; outUsd: number | null; source: string } | null,
  priceUsd: number | null,
  cursor: number = 0
): UnshieldingsResponse {
  const cutoffMs = periodCutoff(period)
  const offset = Math.max(0, cursor)
  const pageLimit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const pageFlows = windowFlows.slice(offset, offset + pageLimit)
  const pageTraces = pageFlows
    .map((flow) => traceMap.get(flowIdentity(flow)))
    .filter((trace): trace is PostUnshieldTrace => trace != null)
  // The full window summary is cheap now that traces live in one in-memory
  // blob, so always compute it (no KV reads, no per-page floor heuristics).
  const analyzedWindow = windowFlows
    .map((flow) => traceMap.get(flowIdentity(flow)))
    .filter((trace): trace is PostUnshieldTrace => trace != null)

  const inventoryOutZec = round(
    windowFlows.reduce((sum, flow) => sum + (flow.amountZec ?? 0), 0)
  )
  const aggregateUsable =
    aggregate != null && (aggregate.outTx > 0 || windowFlows.length === 0)
  const outZec = aggregateUsable ? aggregate.outZec : inventoryOutZec
  const outTx = aggregateUsable
    ? Math.max(aggregate.outTx, windowFlows.length)
    : windowFlows.length
  const summary = summarizeTraces(analyzedWindow)
  const analyzed = Math.min(outTx, summary.traced)
  const remaining = Math.max(0, outTx - analyzed)
  const inventoryComplete = inventoryCovers(inventory, cutoffMs)
  const complete = inventoryComplete && analyzed >= outTx && remaining === 0
  const nextOffset = offset + pageLimit

  return {
    activation: {
      label: "NU6.2",
      block: ACTIVATION_BLOCK,
      time: ACTIVATION_TIME,
    },
    pool,
    period,
    sort,
    cutoffTime: new Date(cutoffMs).toISOString(),
    fetchedAt: Date.now(),
    totals: {
      outZec,
      outUsd: aggregateUsable
        ? aggregate.outUsd
        : priceUsd != null
          ? round(outZec * priceUsd, 2)
          : null,
      outTx,
    },
    postUnshield: {
      summary,
      traces: pageTraces,
    },
    analysis: {
      total: outTx,
      analyzed,
      remaining,
      complete,
      warming: !complete,
      cacheHits: analyzed,
      inventoryComplete,
      refreshing: 0,
    },
    pagination: {
      limit: pageLimit,
      total: outTx,
      returned: pageTraces.length,
      hasNext: nextOffset < windowFlows.length,
      nextCursor: nextOffset < windowFlows.length ? nextOffset : null,
      nextCursorId: null,
      reachedPeriodEnd: nextOffset >= windowFlows.length,
    },
    source: {
      flows: aggregateUsable ? aggregate.source : inventory.source,
      list: inventory.source,
    },
    notes: [
      "Window totals use CipherScan pools/flows; trace rows use the cached deshield transaction inventory.",
      complete
        ? "Outcome counts cover every deshield transaction in the selected window."
        : `Outcome cache covers ${analyzed} of ${outTx} transactions and is warming in the background.`,
      "RESHIELD means the same transparent address later moved value into a shielded-touching tx.",
      "SPENT excludes detected reshields and does not prove exchange sale.",
    ],
  }
}

async function writeResponseCache(
  kv: KVLike,
  key: string,
  payload: UnshieldingsResponse
): Promise<void> {
  const json = JSON.stringify(payload)
  const ttl = payload.analysis.complete
    ? COMPLETE_RESPONSE_CACHE_TTL_SECONDS
    : WARMING_RESPONSE_CACHE_TTL_SECONDS
  await Promise.all([
    kv.put(key, json, { expirationTtl: ttl }),
    kv.put(staleResponseCacheKey(key), json),
  ])
}

async function buildAndWriteResponse(
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  cursor: number | null,
  inventory: FlowInventory,
  aggregatePoints: CipherscanFlowsResponse["points"],
  priceUsd: number | null,
  traceMap: Map<string, CachedTrace>,
  kv: KVLike
): Promise<void> {
  const cutoffMs = periodCutoff(period)
  const aggregate = aggregateForCutoff(
    aggregatePoints,
    cutoffMs,
    priceUsd,
    flowsUrl(pool).toString()
  )
  const windowFlows = inventory.flows.filter((flow) => {
    const ms = flowTimeMs(flow)
    return ms != null && ms >= cutoffMs
  })
  const sorted = sortWindowFlows(windowFlows, sort)
  const key = responseCacheKey(pool, period, sort, limit, cursor)
  const flowTraces = traceMapForFlows(sorted, traceMap)
  const payload = buildResponseForPeriod(
    pool,
    period,
    sort,
    limit,
    inventory,
    sorted,
    flowTraces,
    aggregate,
    priceUsd,
    cursor ?? 0
  )
  await writeResponseCache(kv, key, payload)
}

async function updateResponseCaches(
  pool: PoolMode,
  inventory: FlowInventory,
  kv: KVLike,
  priceUsd: number | null,
  traceMap: Map<string, CachedTrace>,
  prioritize?: WorkerOptions["prioritize"],
  buildAllPresets = true
): Promise<void> {
  const points = await fetchAggregatePoints(pool)

  // Build the response that a waiting client asked for first.
  if (prioritize) {
    await buildAndWriteResponse(
      pool,
      prioritize.period,
      prioritize.sort,
      prioritize.limit,
      prioritize.cursor,
      inventory,
      points,
      priceUsd,
      traceMap,
      kv
    )
  }

  if (!buildAllPresets) return

  // Then warm the common presets. Traces come from the in-memory blob, so each
  // preset is a pure computation + one response-cache write (no trace reads).
  for (const period of PERIODS) {
    for (const sort of SORTS) {
      for (const cursor of [0, DEFAULT_LIMIT]) {
        // Already built above; skip to avoid duplicate work.
        if (
          prioritize &&
          prioritize.period === period &&
          prioritize.sort === sort &&
          prioritize.limit === DEFAULT_LIMIT &&
          (prioritize.cursor ?? 0) === cursor
        ) {
          continue
        }
        await buildAndWriteResponse(
          pool,
          period,
          sort,
          DEFAULT_LIMIT,
          cursor,
          inventory,
          points,
          priceUsd,
          traceMap,
          kv
        )
      }
    }
  }
}

/** Count blob entries that have a non-null trace — used as a progress floor. */
function countClassifiedTraces(traceMap: Map<string, CachedTrace>): number {
  let n = 0
  for (const cached of traceMap.values()) {
    if (cached.trace) n++
  }
  return n
}

async function updateProgress(
  kv: KVLike,
  pool: PoolMode,
  inventory: FlowInventory,
  traceMap: Map<string, CachedTrace>,
  reachedEnd: boolean,
  batchEmpty: boolean,
  nextScanOffset?: number
): Promise<void> {
  // The blob gives the exact classified count (post-classification), so use it
  // directly as the floor instead of the old "previous + successful" increment,
  // which would double-count the traces just added to the blob.
  const classifiedCount = countClassifiedTraces(traceMap)
  const progress =
    parseProgress(await kv.get(progressKey(pool))) ?? {
      total: inventory.flows.length,
      classified: classifiedCount,
      lastRunAt: 0,
      complete: false,
    }
  // The blob is the source of truth for both totals and classified counts, so
  // set them directly rather than maxing with the previous value — that lets the
  // progress self-correct if a prior run overcounted (e.g. the old increment
  // model) instead of pinning a stale high value forever.
  progress.total = inventory.flows.length
  progress.classified = classifiedCount
  progress.lastRunAt = Date.now()
  if (typeof nextScanOffset === "number") {
    progress.scanOffset = Math.max(0, Math.min(progress.total, nextScanOffset))
  }
  progress.complete =
    inventory.complete && reachedEnd && batchEmpty && progress.classified >= progress.total
  await kv.put(progressKey(pool), JSON.stringify(progress))
}

export interface WorkerOptions {
  /** Set false to skip trace classification (response-only builds). */
  classify?: boolean
  /** Set false for cron backfills that should only classify and update progress. */
  buildResponses?: boolean
  /** Set false for backlog cron runs so they classify new txs before rechecks. */
  recheckCachedTraces?: boolean
  /** Set false for cron runs that should not copy/sort the full head inventory. */
  refreshHead?: boolean
  /** Set false to use the cached inventory as-is (no upstream refresh). */
  refreshInventory?: boolean
  /** Set false if incomplete inventories should only be extended, not traced. */
  classifyPartialInventory?: boolean
  /** Number of traces to classify in one run. */
  classificationBatchSize?: number
  /** Number of deshield inventory pages to extend in one worker run. */
  inventoryPageBudget?: number
  /** Set false when a request should only rebuild its own response cache. */
  buildAllPresets?: boolean
  /** Build this specific response first so a waiting client sees it ASAP. */
  prioritize?: {
    period: UnshieldingPeriod
    sort: UnshieldingSort
    limit: number
    cursor: number | null
  }
}

export async function runUnshieldingWorker(
  pool: PoolMode,
  kv: KVLike,
  options: WorkerOptions = {}
): Promise<void> {
  const now = Date.now()
  const priceUsd = await fetchLiveZecPrice(kv)

  // Phase 1: ensure inventory is loaded/extended. The HTTP path passes
  // refreshInventory:false so it never hits upstream CipherScan; it just builds
  // a response from whatever inventory the cron already cached.
  let inventory = await loadInventory(kv, pool)
  const hasPrioritize = options.prioritize != null
  const inventoryLengthBefore = inventory?.flows.length ?? 0
  const refreshInventory = options.refreshInventory !== false && pool !== "all"
  const needsInventory =
    refreshInventory &&
    (!inventory ||
      !inventory.complete ||
      now - inventory.fetchedAt > INVENTORY_REFRESH_MS ||
      hasPrioritize)

  if (needsInventory) {
    try {
      const pageBudget = Math.max(
        1,
        Math.min(20, Math.floor(options.inventoryPageBudget ?? 1))
      )
      const headFetchedAt = inventory?.headFetchedAt ?? 0
      if (
        options.refreshHead !== false &&
        inventory &&
        (now - headFetchedAt > INVENTORY_REFRESH_MS || hasPrioritize)
      ) {
        inventory = await refreshInventoryHead(pool, inventory)
      }
      if (!inventory || !inventory.complete) {
        for (let page = 0; page < pageBudget; page++) {
          inventory = await refreshInventoryPage(pool, inventory)
          if (inventory.complete) break
        }
      }
      if (inventory) await saveInventory(kv, pool, inventory)
    } catch (err) {
      if (!inventory) throw err
    }
  }

  if (!inventory) return
  const inventoryChanged = inventory.flows.length !== inventoryLengthBefore

  // Load the trace blob once — every phase below reads from this in-memory map.
  const traceMap = await loadTraceBlob(kv, pool)

  // Phase 2: classify the next chunk when inventory is fresh enough. Only the
  // cron classifies; the HTTP path passes classify:false.
  let successful = 0
  let classifiedThisRun = false
  const inventoryFresh =
    inventory.complete || now - inventory.fetchedAt <= INVENTORY_REFRESH_MS
  const shouldClassify =
    options.classify !== false &&
    inventoryFresh &&
    (inventory.complete || options.classifyPartialInventory !== false)
  if (shouldClassify) {
    const prioritizeCutoffMs = hasPrioritize
      ? periodCutoff(options.prioritize!.period)
      : null
    const batchSize = Math.max(
      0,
      Math.min(
        CLASSIFICATION_BATCH_SIZE,
        Math.floor(options.classificationBatchSize ?? CLASSIFICATION_BATCH_SIZE)
      )
    )
    const priorProgress = parseProgress(await kv.get(progressKey(pool)))
    const scanStartOffset = hasPrioritize
      ? 0
      : priorProgress?.scanOffset ?? 0
    const { flows: batch, previous, reachedEnd, nextScanOffset } =
      batchSize > 0
        ? findUnclassifiedBatch(
            inventory,
            traceMap,
            batchSize,
            prioritizeCutoffMs,
            options.recheckCachedTraces ?? true,
            scanStartOffset
          )
        : {
            flows: [],
            previous: new Map<string, CachedTrace>(),
            reachedEnd: false,
            nextScanOffset: scanStartOffset,
          }
    if (batch.length > 0) {
      const limiter = new RateLimiter(
        RATE_LIMIT_CAPACITY,
        RATE_LIMIT_REFILL_MS
      )
      successful = await classifyBatch(
        batch,
        previous,
        traceMap,
        limiter,
        priceUsd
      )
      classifiedThisRun = true
      await updateProgress(
        kv,
        pool,
        inventory,
        traceMap,
        reachedEnd,
        false,
        nextScanOffset
      )
    } else if (reachedEnd) {
      await updateProgress(
        kv,
        pool,
        inventory,
        traceMap,
        true,
        true,
        inventory.complete ? 0 : inventory.flows.length
      )
    }
  } else if (inventoryFresh && options.classify !== false) {
    await updateProgress(
      kv,
      pool,
      inventory,
      traceMap,
      false,
      false,
      inventory.flows.length
    )
  }

  // Persist the trace blob once if classification touched it. One write per run
  // replaces what used to be one write per trace.
  if (classifiedThisRun) {
    await saveTraceBlob(kv, pool, traceMap).catch(() => {})
  }

  // Phase 3: rebuild response caches. The cron builds all presets; the HTTP
  // path builds only its prioritized window. Both read traces from the
  // in-memory blob, so there are zero per-trace KV reads here.
  const buildAllPresets =
    options.buildAllPresets ??
    (successful > 0 || inventoryChanged || !hasPrioritize)
  if (options.buildResponses !== false) {
    await updateResponseCaches(
      pool,
      inventory,
      kv,
      priceUsd,
      traceMap,
      options.prioritize,
      buildAllPresets
    )
  }
}
