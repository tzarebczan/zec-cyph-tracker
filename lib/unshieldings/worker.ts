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
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "@/components/api-types"
import {
  ACTIVATION_BLOCK,
  ACTIVATION_TIME,
  DEFAULT_LIMIT,
  INVENTORY_PAGE_SIZE,
  INVENTORY_REFRESH_MS,
  INVENTORY_TTL_SECONDS,
  MAX_LIMIT,
  PERIODS,
  RESPONSE_CACHE_TTL_SECONDS,
  SORTS,
  TRACE_FAILURE_TTL_SECONDS,
  TRACE_RETRY_BACKOFF_MS,
  TRACE_STORAGE_TTL_SECONDS,
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
  parseCachedTrace,
  parseInventory,
  parseProgress,
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
  traceKey,
  zatoshiToZec,
} from "./shared"

export const CLASSIFICATION_BATCH_SIZE = 20
const RATE_LIMIT_CAPACITY = 75
const RATE_LIMIT_REFILL_MS = 60_000
const ADDRESS_FETCH_CONCURRENCY = 8
const TX_FETCH_CONCURRENCY = 8

async function loadInventory(
  kv: KVLike,
  pool: PoolMode
): Promise<FlowInventory | null> {
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

async function refreshInventoryPage(
  pool: PoolMode,
  existing: FlowInventory | null
): Promise<FlowInventory> {
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
    fetchedAt: Date.now(),
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
    fetchedAt: Date.now(),
    source: url.toString(),
  }
}

async function findUnclassifiedBatch(
  inventory: FlowInventory,
  kv: KVLike,
  batchSize: number,
  prioritizeCutoffMs: number | null = null
): Promise<{
  flows: CipherscanFlow[]
  previous: Map<string, CachedTrace>
  reachedEnd: boolean
}> {
  const flows: CipherscanFlow[] = []
  const previous = new Map<string, CachedTrace>()
  const now = Date.now()

  const processBatch = async (candidates: CipherscanFlow[]) => {
    if (candidates.length === 0) return
    const keys = candidates.map(traceKey)
    let values: Map<string, string | null>
    try {
      values = await kv.get(keys)
    } catch {
      const rows = await Promise.all(
        keys.map(async (key) => [key, await kv.get(key)] as const)
      )
      values = new Map(rows)
    }

    for (let i = 0; i < candidates.length; i++) {
      if (flows.length >= batchSize) return
      const flow = candidates[i]
      const key = keys[i]
      const cached = parseCachedTrace(values.get(key) ?? null)
      const identity = flowIdentity(flow)
      if (cached) {
        previous.set(identity, cached)
        if (cached.trace && !isCachedTraceStale(cached, now)) continue
        const lastAttemptAt = cached.lastAttemptAt ?? cached.checkedAt
        if (!cached.trace && now - lastAttemptAt < TRACE_RETRY_BACKOFF_MS) continue
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
    await processBatch(priorityFlows)
    if (flows.length >= batchSize) {
      return { flows, previous, reachedEnd: false }
    }
  }

  // Second pass: the rest of the inventory (or the whole thing if no priority).
  for (let offset = 0; offset < inventory.flows.length; offset += 100) {
    await processBatch(inventory.flows.slice(offset, offset + 100))
    if (flows.length >= batchSize) {
      return { flows, previous, reachedEnd: false }
    }
  }
  return { flows, previous, reachedEnd: true }
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

async function classifyBatch(
  flows: CipherscanFlow[],
  previous: Map<string, CachedTrace>,
  kv: KVLike,
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
    if (!addr || !flow.txid) {
      const now = Date.now()
      await kv.put(
        traceKey(flow),
        JSON.stringify({ trace: null, checkedAt: now, lastAttemptAt: now } as CachedTrace),
        { expirationTtl: TRACE_FAILURE_TTL_SECONDS }
      )
      continue
    }
    const addressDetail = addressMap.get(addr) ?? null
    const txDetail = txMap.get(flow.txid) ?? null
    const identity = flowIdentity(flow)
    const previousEntry = previous.get(identity) ?? null
    const candidate = buildTrace(flow, txDetail, addressDetail, priceUsd)

    if (!candidate) {
      const now = Date.now()
      const failed: CachedTrace = {
        trace: previousEntry?.trace ?? null,
        checkedAt: previousEntry?.checkedAt ?? now,
        lastAttemptAt: now,
      }
      await kv.put(traceKey(flow), JSON.stringify(failed), {
        expirationTtl: previousEntry?.trace
          ? TRACE_STORAGE_TTL_SECONDS
          : TRACE_FAILURE_TTL_SECONDS,
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
    const cached: CachedTrace = preservePrevious
      ? {
          trace: previousTrace,
          checkedAt: previousEntry?.checkedAt ?? now,
          lastAttemptAt: now,
        }
      : { trace, checkedAt: now, lastAttemptAt: now }
    await kv.put(traceKey(flow), JSON.stringify(cached), {
      expirationTtl: TRACE_STORAGE_TTL_SECONDS,
    })
    successful++
  }
  return successful
}

async function loadTraceMap(
  flows: CipherscanFlow[],
  kv: KVLike
): Promise<Map<string, PostUnshieldTrace>> {
  const map = new Map<string, PostUnshieldTrace>()
  for (let offset = 0; offset < flows.length; offset += 100) {
    const batch = flows.slice(offset, offset + 100)
    const keys = batch.map(traceKey)
    let values: Map<string, string | null>
    try {
      values = await kv.get(keys)
    } catch {
      const rows = await Promise.all(
        keys.map(async (key) => [key, await kv.get(key)] as const)
      )
      values = new Map(rows)
    }
    for (let i = 0; i < batch.length; i++) {
      const flow = batch[i]
      const cached = parseCachedTrace(values.get(keys[i]) ?? null)
      if (cached?.trace) {
        map.set(flowIdentity(flow), cached.trace)
      }
    }
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
  const analyzed = analyzedWindow.length
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
      summary: summarizeTraces(analyzedWindow),
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
  await Promise.all([
    kv.put(key, json, { expirationTtl: RESPONSE_CACHE_TTL_SECONDS }),
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
  // Only load the traces needed for this window — much cheaper for short
  // windows like 1h than reading the entire inventory's trace cache.
  const traceMap = await loadTraceMap(sorted, kv)
  const payload = buildResponseForPeriod(
    pool,
    period,
    sort,
    limit,
    inventory,
    sorted,
    traceMap,
    aggregate,
    priceUsd,
    cursor ?? 0
  )
  const key = responseCacheKey(pool, period, sort, limit, cursor)
  await writeResponseCache(kv, key, payload)
}

async function updateResponseCaches(
  pool: PoolMode,
  inventory: FlowInventory,
  kv: KVLike,
  priceUsd: number | null,
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
      kv
    )
  }

  if (!buildAllPresets) return

  // Then warm the common presets. Reading all traces once is cheaper than
  // re-reading per period when we're building every preset anyway.
  const traceMap = await loadTraceMap(inventory.flows, kv)
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
        const cutoffMs = periodCutoff(period)
        const aggregate = aggregateForCutoff(
          points,
          cutoffMs,
          priceUsd,
          flowsUrl(pool).toString()
        )
        const windowFlows = inventory.flows.filter((flow) => {
          const ms = flowTimeMs(flow)
          return ms != null && ms >= cutoffMs
        })
        const sorted = sortWindowFlows(windowFlows, sort)
        const payload = buildResponseForPeriod(
          pool,
          period,
          sort,
          DEFAULT_LIMIT,
          inventory,
          sorted,
          traceMap,
          aggregate,
          priceUsd,
          cursor
        )
        const key = responseCacheKey(pool, period, sort, DEFAULT_LIMIT, cursor)
        await writeResponseCache(kv, key, payload)
      }
    }
  }
}

async function updateProgress(
  kv: KVLike,
  pool: PoolMode,
  inventory: FlowInventory,
  successful: number,
  reachedEnd: boolean,
  batchEmpty: boolean
): Promise<void> {
  const progress =
    parseProgress(await kv.get(progressKey(pool))) ?? {
      total: inventory.flows.length,
      classified: 0,
      lastRunAt: 0,
      complete: false,
    }
  progress.total = inventory.flows.length
  progress.classified = Math.min(
    progress.classified + successful,
    progress.total
  )
  progress.lastRunAt = Date.now()
  progress.complete =
    inventory.complete && reachedEnd && batchEmpty && progress.classified >= progress.total
  await kv.put(progressKey(pool), JSON.stringify(progress))
}

export interface WorkerOptions {
  force?: boolean
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

  // Phase 1: ensure inventory is loaded/extended.
  let inventory = await loadInventory(kv, pool)
  const hasPrioritize = options.prioritize != null
  const inventoryLengthBefore = inventory?.flows.length ?? 0
  // When a client is waiting on a specific window, refresh the inventory head
  // first so new flows show up immediately instead of waiting for the next
  // 5-minute refresh cycle.
  const needsInventory =
    !inventory ||
    options.force ||
    !inventory.complete ||
    now - inventory.fetchedAt > INVENTORY_REFRESH_MS ||
    hasPrioritize

  if (needsInventory) {
    try {
      if (
        inventory &&
        (inventory.complete || hasPrioritize) &&
        (now - inventory.fetchedAt > INVENTORY_REFRESH_MS || hasPrioritize)
      ) {
        inventory = await refreshInventoryHead(pool, inventory)
      } else {
        inventory = await refreshInventoryPage(pool, inventory)
      }
      await saveInventory(kv, pool, inventory)
    } catch (err) {
      if (!inventory) throw err
    }
  }

  if (!inventory) return
  const inventoryChanged = inventory.flows.length !== inventoryLengthBefore

  // Phase 2: classify the next chunk when inventory is fresh enough.
  let successful = 0
  const inventoryFresh =
    inventory.complete || now - inventory.fetchedAt <= INVENTORY_REFRESH_MS
  if (inventoryFresh) {
    const prioritizeCutoffMs = hasPrioritize
      ? periodCutoff(options.prioritize!.period)
      : null
    const { flows: batch, previous, reachedEnd } = await findUnclassifiedBatch(
      inventory,
      kv,
      CLASSIFICATION_BATCH_SIZE,
      prioritizeCutoffMs
    )
    if (batch.length > 0) {
      const limiter = new RateLimiter(
        RATE_LIMIT_CAPACITY,
        RATE_LIMIT_REFILL_MS
      )
      successful = await classifyBatch(batch, previous, kv, limiter, priceUsd)
      await updateProgress(kv, pool, inventory, successful, reachedEnd, false)
    } else if (reachedEnd) {
      await updateProgress(kv, pool, inventory, 0, true, true)
    }
  }

  // Phase 3: rebuild response caches. Always build the prioritized response
  // so a waiting client sees progress. Rebuild all presets only when there's
  // real new data to show (new traces classified or inventory grew) or when
  // explicitly forced — this avoids reading the entire trace cache on every
  // poll, which can time out with large inventories.
  const buildAllPresets =
    options.force || successful > 0 || inventoryChanged || !hasPrioritize
  await updateResponseCaches(
    pool,
    inventory,
    kv,
    priceUsd,
    options.prioritize,
    buildAllPresets
  )
}
