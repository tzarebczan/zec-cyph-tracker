import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  PostUnshieldEvent,
  PostUnshieldStatus,
  PostUnshieldSummary,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingsResponse,
} from "@/components/api-types"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const KRAKEN_ZEC_TICKER =
  "https://api.kraken.com/0/public/Ticker?pair=ZECUSD"
const ACTIVATION_BLOCK = 3_364_600
const ACTIVATION_TIME = "2026-06-03T04:03:08Z"
const FLOW_PERIOD = "90d"
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 40
const KV_KEY_PREFIX = "zec.unshieldings.v2"
const PRICE_KV_KEY = "zec.live-price.kraken.v1"
const PRICE_KV_STALE_KEY = "zec.live-price.kraken.stale.v1"
const KV_TTL_SECONDS = 60
const PRICE_KV_TTL_SECONDS = 60

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-unshielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30",
}
const FORCE_REFRESH_HEADERS = {
  "Cache-Control": "no-store",
}

type PoolMode = "orchard" | "all"

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

interface KrakenTickerResponse {
  error?: string[]
  result?: Record<string, { c?: string[] }>
}

interface CipherscanFlowPoint {
  date?: string
  deshield?: number
  deshieldTx?: number
}

interface CipherscanFlowsResponse {
  points?: CipherscanFlowPoint[]
}

interface CipherscanFlow {
  id?: number
  txid?: string
  blockHeight?: number
  blockTime?: number
  flowType?: string
  amountZec?: number
  pool?: string
  addresses?: string[]
}

interface CipherscanListResponse {
  success?: boolean
  flows?: CipherscanFlow[]
  pagination?: {
    total?: number
    totalPages?: number
    limit?: number
    hasNext?: boolean
    nextCursor?: number
    nextCursorId?: number
  }
}

interface CipherscanTxOutput {
  address?: string | null
  value?: string | number | null
  spent?: boolean
}

interface CipherscanTxDetail {
  outputs?: CipherscanTxOutput[]
}

interface CipherscanAddressTx {
  txid?: string
  blockHeight?: number
  blockTime?: string | number
  hasSapling?: boolean
  hasOrchard?: boolean
  hasSprout?: boolean
  inputValue?: number
  netChange?: number
}

interface CipherscanAddressResponse {
  balance?: number
  totalReceived?: number
  totalSent?: number
  txCount?: number
  lastSeen?: string | number
  transactions?: CipherscanAddressTx[]
}

function parsePool(request: Request): PoolMode {
  const pool = new URL(request.url).searchParams.get("pool")
  return pool === "all" ? "all" : "orchard"
}

function parsePeriod(request: Request): UnshieldingPeriod {
  const period = new URL(request.url).searchParams.get("period")
  if (
    period === "1h" ||
    period === "12h" ||
    period === "1d" ||
    period === "1w" ||
    period === "1m" ||
    period === "all"
  ) {
    return period
  }
  return "1d"
}

function parseLimit(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get("limit"))
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)))
}

function parseCursor(request: Request): { cursor: number | null; cursorId: number | null } {
  const params = new URL(request.url).searchParams
  const rawCursor = params.get("cursor")
  const rawCursorId = params.get("cursorId") ?? params.get("cursor_id")
  const cursor = rawCursor == null ? NaN : Number(rawCursor)
  const cursorId = rawCursorId == null ? NaN : Number(rawCursorId)
  return {
    cursor: Number.isFinite(cursor) ? cursor : null,
    cursorId: Number.isFinite(cursorId) ? cursorId : null,
  }
}

function shouldForceRefresh(request: Request): boolean {
  const params = new URL(request.url).searchParams
  return params.has("refresh") || params.has("fresh") || params.has("bust")
}

async function getKv(): Promise<KVLike | null> {
  try {
    const cf = await getCloudflareContext({ async: true })
    return (cf?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
  } catch {
    return null
  }
}

function cacheKey(
  pool: PoolMode,
  period: UnshieldingPeriod,
  limit: number,
  cursor: number | null,
  cursorId: number | null
) {
  return `${KV_KEY_PREFIX}.${pool}.${period}.${limit}.${cursor ?? "head"}.${
    cursorId ?? "head"
  }`
}

async function fetchJson<T>(url: URL | string): Promise<T> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`CipherScan ${res.status} for ${String(url)}`)
  return (await res.json()) as T
}

function flowUrl(pool: PoolMode): URL {
  const url = new URL(`${CIPHERSCAN}/pools/flows`)
  url.searchParams.set("period", FLOW_PERIOD)
  url.searchParams.set("granularity", "hourly")
  if (pool === "orchard") url.searchParams.set("pool", "orchard")
  return url
}

function listUrl(
  pool: PoolMode,
  limit: number,
  cursor: number | null,
  cursorId: number | null
): URL {
  const url = new URL(`${CIPHERSCAN}/shielded/list`)
  url.searchParams.set("flow_type", "deshield")
  url.searchParams.set("limit", String(limit))
  if (pool === "orchard") url.searchParams.set("pool", "orchard")
  if (cursor != null) url.searchParams.set("cursor", String(cursor))
  if (cursorId != null) url.searchParams.set("cursorId", String(cursorId))
  return url
}

function txDetailUrl(hash: string): URL {
  return new URL(`${CIPHERSCAN}/tx/${hash}`)
}

function addressDetailUrl(address: string): URL {
  const url = new URL(`${CIPHERSCAN}/address/${address}`)
  url.searchParams.set("limit", "50")
  return url
}

function parsePositiveNumber(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function extractKrakenPrice(json: KrakenTickerResponse): number | null {
  if (json.error?.length) return null
  const firstPair = Object.values(json.result ?? {})[0]
  const price = firstPair?.c?.[0] ? Number(firstPair.c[0]) : null
  return price != null && Number.isFinite(price) && price > 0 ? price : null
}

async function fetchLiveZecPrice(kv: KVLike | null): Promise<number | null> {
  if (kv) {
    try {
      const cached = parsePositiveNumber(await kv.get(PRICE_KV_KEY))
      if (cached != null) return cached
    } catch {}
  }
  try {
    const res = await fetch(KRAKEN_ZEC_TICKER, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const price = extractKrakenPrice((await res.json()) as KrakenTickerResponse)
      if (price != null) {
        if (kv) {
          await Promise.all([
            kv.put(PRICE_KV_KEY, String(price), {
              expirationTtl: PRICE_KV_TTL_SECONDS,
            }),
            kv.put(PRICE_KV_STALE_KEY, String(price)),
          ]).catch(() => {})
        }
        return price
      }
    }
  } catch {}
  if (kv) {
    try {
      return parsePositiveNumber(await kv.get(PRICE_KV_STALE_KEY))
    } catch {}
  }
  return null
}

function periodCutoff(period: UnshieldingPeriod): number {
  const activationMs = Date.parse(ACTIVATION_TIME)
  const now = Date.now()
  const hour = 60 * 60 * 1000
  const cut =
    period === "1h"
      ? now - hour
      : period === "12h"
        ? now - 12 * hour
        : period === "1d"
          ? now - 24 * hour
          : period === "1w"
            ? now - 7 * 24 * hour
            : period === "1m"
              ? now - 30 * 24 * hour
              : activationMs
  return Math.max(activationMs, cut)
}

function round(n: number, places = 8): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

function zatoshiToZec(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === "string" ? Number(value) : value
  return Number.isFinite(n) ? round(n / 100_000_000) : null
}

function secondsToIso(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const n = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

function addressTxToEvent(tx: CipherscanAddressTx): PostUnshieldEvent | null {
  if (!tx.txid || typeof tx.blockHeight !== "number") return null
  const amount = zatoshiToZec(Math.max(Math.abs(tx.netChange ?? 0), tx.inputValue ?? 0))
  return {
    hash: tx.txid,
    block: tx.blockHeight,
    time: secondsToIso(tx.blockTime) ?? "",
    amountZec: amount ?? 0,
    shieldedTouch: Boolean(tx.hasOrchard || tx.hasSapling || tx.hasSprout),
  }
}

function touchesShieldedPool(tx: CipherscanAddressTx): boolean {
  return Boolean(tx.hasOrchard || tx.hasSapling || tx.hasSprout)
}

function isOutgoingTx(tx: CipherscanAddressTx): boolean {
  return (tx.inputValue ?? 0) > 0 || (tx.netChange ?? 0) < 0
}

function reshieldType(
  reshield: PostUnshieldEvent | null,
  deshieldAmountZec: number
) {
  if (!reshield || deshieldAmountZec <= 0) return null
  return reshield.amountZec >= deshieldAmountZec * 0.995 ? "full" : "partial"
}

function emptySummary(): PostUnshieldSummary {
  return {
    traced: 0,
    held: 0,
    spent: 0,
    reshielded: 0,
    reshieldedFull: 0,
    reshieldedPartial: 0,
    reused: 0,
    unknown: 0,
    priorShieldSource: 0,
    tracedZec: 0,
    heldZec: 0,
    spentZec: 0,
    reshieldedZec: 0,
    reusedZec: 0,
  }
}

function summarizeTraces(traces: PostUnshieldTrace[]): PostUnshieldSummary {
  const summary = emptySummary()
  for (const trace of traces) {
    summary.traced += 1
    summary.tracedZec += trace.amountZec
    if (trace.status === "held") {
      summary.held += 1
      summary.heldZec += trace.amountZec
    } else if (trace.status === "spent") {
      summary.spent += 1
      summary.spentZec += trace.amountZec
    } else if (trace.status === "reshielded") {
      summary.reshielded += 1
      summary.reshieldedZec += trace.reshield?.amountZec ?? trace.amountZec
      if (trace.reshieldType === "full") summary.reshieldedFull += 1
      if (trace.reshieldType === "partial") summary.reshieldedPartial += 1
    } else if (trace.status === "reused") {
      summary.reused += 1
      summary.reusedZec += trace.amountZec
    } else {
      summary.unknown += 1
    }
    if (trace.priorShieldSource) summary.priorShieldSource += 1
  }
  return {
    ...summary,
    tracedZec: round(summary.tracedZec),
    heldZec: round(summary.heldZec),
    spentZec: round(summary.spentZec),
    reshieldedZec: round(summary.reshieldedZec),
    reusedZec: round(summary.reusedZec),
  }
}

async function fetchTxDetail(hash: string): Promise<CipherscanTxDetail | null> {
  try {
    return await fetchJson<CipherscanTxDetail>(txDetailUrl(hash))
  } catch {
    return null
  }
}

async function fetchAddressDetail(
  address: string
): Promise<CipherscanAddressResponse | null> {
  try {
    return await fetchJson<CipherscanAddressResponse>(addressDetailUrl(address))
  } catch {
    return null
  }
}

async function traceFlow(
  flow: CipherscanFlow,
  priceUsd: number | null
): Promise<PostUnshieldTrace | null> {
  if (!flow.txid || typeof flow.blockHeight !== "number") return null
  const address = flow.addresses?.find(Boolean)
  if (!address) return null
  const time = secondsToIso(flow.blockTime)
  if (!time) return null
  const amountZec =
    typeof flow.amountZec === "number" && Number.isFinite(flow.amountZec)
      ? round(flow.amountZec)
      : 0

  const [txDetail, addressDetail] = await Promise.all([
    fetchTxDetail(flow.txid),
    fetchAddressDetail(address),
  ])
  const txTimeMs = Date.parse(time)
  const txOutput = txDetail?.outputs?.find((output) => output.address === address)
  const outputSpent =
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
  const priorShieldSource = priorShieldRow ? addressTxToEvent(priorShieldRow) : null

  const tracedAmount = outputAmount ?? amountZec
  let status: PostUnshieldStatus = "unknown"
  const nextReshieldType = reshieldType(reshield, tracedAmount)
  if (reshield) {
    status = "reshielded"
  } else if (outputSpent === true || nextSpend) {
    status = "spent"
  } else if (outputSpent === false && (priorShieldSource || hasPriorHistory)) {
    status = "reused"
  } else if (outputSpent === false) {
    status = "held"
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
      typeof addressDetail?.txCount === "number" ? addressDetail.txCount : null,
    lastSeen: secondsToIso(addressDetail?.lastSeen),
    nextSpend,
    reshield,
    reshieldType: nextReshieldType,
    priorShieldSource,
    explorerUrl: `https://cipherscan.app/tx/${flow.txid}`,
    addressUrl: `https://cipherscan.app/address/${address}`,
  }
}

async function fetchWindowTotals(
  pool: PoolMode,
  cutoffMs: number,
  priceUsd: number | null
) {
  const url = flowUrl(pool)
  const json = await fetchJson<CipherscanFlowsResponse>(url)
  let outZec = 0
  let outTx = 0
  for (const point of json.points ?? []) {
    if (!point.date) continue
    const ms = Date.parse(point.date)
    if (!Number.isFinite(ms) || ms < cutoffMs) continue
    outZec += typeof point.deshield === "number" ? point.deshield : 0
    outTx += typeof point.deshieldTx === "number" ? point.deshieldTx : 0
  }
  return {
    outZec: round(outZec),
    outUsd: priceUsd != null ? round(outZec * priceUsd, 2) : null,
    outTx,
    url: url.toString(),
  }
}

async function fetchListTotals(
  pool: PoolMode,
  cutoffMs: number,
  priceUsd: number | null,
  maxRows = 2_000
) {
  let outZec = 0
  let outTx = 0
  let cursor: number | null = null
  let cursorId: number | null = null
  let reachedPeriodEnd = false
  let hasNext = true
  let lastUrl = listUrl(pool, 100, cursor, cursorId).toString()

  while (hasNext && !reachedPeriodEnd && outTx < maxRows) {
    const url = listUrl(pool, 100, cursor, cursorId)
    lastUrl = url.toString()
    const json = await fetchJson<CipherscanListResponse>(url)
    hasNext = Boolean(json.pagination?.hasNext)
    cursor = json.pagination?.nextCursor ?? null
    cursorId = json.pagination?.nextCursorId ?? null
    const rows = json.flows ?? []
    if (rows.length === 0) break
    for (const flow of rows) {
      const ms =
        typeof flow.blockTime === "number" && Number.isFinite(flow.blockTime)
          ? flow.blockTime * 1000
          : null
      if (ms != null && ms < cutoffMs) {
        reachedPeriodEnd = true
        break
      }
      if (flow.flowType !== "deshield") continue
      outTx += 1
      outZec +=
        typeof flow.amountZec === "number" && Number.isFinite(flow.amountZec)
          ? flow.amountZec
          : 0
      if (outTx >= maxRows) break
    }
  }

  return {
    outZec: round(outZec),
    outUsd: priceUsd != null ? round(outZec * priceUsd, 2) : null,
    outTx,
    complete: reachedPeriodEnd || !hasNext,
    url: lastUrl,
  }
}

async function fetchFlowPage(
  pool: PoolMode,
  cutoffMs: number,
  limit: number,
  startCursor: number | null,
  startCursorId: number | null
) {
  const flows: CipherscanFlow[] = []
  let cursor = startCursor
  let cursorId = startCursorId
  let hasNext = false
  let reachedPeriodEnd = false
  let lastUrl = listUrl(pool, limit, cursor, cursorId).toString()

  for (let page = 0; page < 8 && flows.length < limit && !reachedPeriodEnd; page += 1) {
    const url = listUrl(pool, limit, cursor, cursorId)
    lastUrl = url.toString()
    const json = await fetchJson<CipherscanListResponse>(url)
    const pageFlows = json.flows ?? []
    hasNext = Boolean(json.pagination?.hasNext)
    cursor = json.pagination?.nextCursor ?? null
    cursorId = json.pagination?.nextCursorId ?? null

    for (const flow of pageFlows) {
      const ms =
        typeof flow.blockTime === "number" && Number.isFinite(flow.blockTime)
          ? flow.blockTime * 1000
          : null
      if (ms != null && ms < cutoffMs) {
        reachedPeriodEnd = true
        break
      }
      if (flow.flowType === "deshield") flows.push(flow)
      if (flows.length >= limit) break
    }
    if (!hasNext || pageFlows.length === 0) break
  }

  return {
    flows: flows.slice(0, limit),
    hasNext: hasNext && !reachedPeriodEnd,
    nextCursor: hasNext && !reachedPeriodEnd ? cursor : null,
    nextCursorId: hasNext && !reachedPeriodEnd ? cursorId : null,
    reachedPeriodEnd,
    url: lastUrl,
  }
}

function isResponse(payload: UnshieldingsResponse | null): payload is UnshieldingsResponse {
  return payload?.postUnshield?.summary != null && payload.pagination != null
}

function parseCachedPayload(cached: string | null): UnshieldingsResponse | null {
  if (!cached) return null
  try {
    const parsed = JSON.parse(cached) as UnshieldingsResponse
    return isResponse(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function buildResponse(
  pool: PoolMode,
  period: UnshieldingPeriod,
  limit: number,
  cursor: number | null,
  cursorId: number | null,
  priceUsd: number | null
): Promise<UnshieldingsResponse> {
  const cutoffMs = periodCutoff(period)
  const [flowTotalsResult, listTotalsResult, pageResult] =
    await Promise.allSettled([
      fetchWindowTotals(pool, cutoffMs, priceUsd),
      period === "1h" || period === "12h" || period === "1d"
        ? fetchListTotals(pool, cutoffMs, priceUsd)
        : Promise.resolve(null),
      fetchFlowPage(pool, cutoffMs, limit, cursor, cursorId),
    ])
  if (flowTotalsResult.status === "rejected") throw flowTotalsResult.reason
  const flowTotals = flowTotalsResult.value
  const listTotals =
    listTotalsResult.status === "fulfilled" ? listTotalsResult.value : null
  const listError =
    listTotalsResult.status === "rejected"
      ? listTotalsResult.reason instanceof Error
        ? listTotalsResult.reason.message
        : "CipherScan list totals unavailable"
      : null
  const page =
    pageResult.status === "fulfilled"
      ? pageResult.value
      : {
          flows: [],
          hasNext: false,
          nextCursor: null,
          nextCursorId: null,
          reachedPeriodEnd: false,
          url: listUrl(pool, limit, cursor, cursorId).toString(),
        }
  const pageError =
    pageResult.status === "rejected"
      ? pageResult.reason instanceof Error
        ? pageResult.reason.message
        : "CipherScan list page unavailable"
      : null
  const totals =
    listTotals != null && (listTotals.complete || listTotals.outTx > flowTotals.outTx)
      ? listTotals
      : flowTotals
  const traces = (
    await Promise.all(page.flows.map((flow) => traceFlow(flow, priceUsd)))
  ).filter((trace): trace is PostUnshieldTrace => trace != null)

  return {
    activation: {
      label: "NU6.2",
      block: ACTIVATION_BLOCK,
      time: ACTIVATION_TIME,
    },
    pool,
    period,
    cutoffTime: new Date(cutoffMs).toISOString(),
    fetchedAt: Date.now(),
    totals: {
      outZec: totals.outZec,
      outUsd: totals.outUsd,
      outTx: totals.outTx,
    },
    postUnshield: {
      summary: summarizeTraces(traces),
      traces,
    },
    pagination: {
      limit,
      returned: traces.length,
      hasNext: page.hasNext,
      nextCursor: page.nextCursor,
      nextCursorId: page.nextCursorId,
      reachedPeriodEnd: page.reachedPeriodEnd,
    },
    source: {
      flows: flowTotals.url,
      list: page.url,
    },
    notes: [
      listTotals != null && totals === listTotals
        ? "Window totals use CipherScan shielded/list because it is fresher for short windows."
        : "Window totals use CipherScan pools/flows hourly aggregates.",
      "Outcome counts summarize the deshield transactions analyzed below.",
      "RESHIELD means the same transparent address later moved value into a shielded-touching tx.",
      "SPENT excludes detected reshields and does not prove exchange sale.",
      ...(listError ? [listError] : []),
      ...(pageError ? [pageError] : []),
    ],
  }
}

export async function GET(request: Request) {
  const pool = parsePool(request)
  const period = parsePeriod(request)
  const limit = parseLimit(request)
  const { cursor, cursorId } = parseCursor(request)
  const forceRefresh = shouldForceRefresh(request)
  const headers = forceRefresh ? FORCE_REFRESH_HEADERS : RESPONSE_HEADERS
  const kv = await getKv()
  const key = cacheKey(pool, period, limit, cursor, cursorId)
  const priceUsd = await fetchLiveZecPrice(kv)

  if (kv && !forceRefresh) {
    try {
      const cached = parseCachedPayload(await kv.get(key))
      if (cached) return NextResponse.json(cached, { headers })
    } catch {}
  }

  try {
    const payload = await buildResponse(pool, period, limit, cursor, cursorId, priceUsd)
    if (kv) {
      try {
        await kv.put(key, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS })
      } catch {}
    }
    return NextResponse.json(payload, { headers })
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "ZEC unshieldings upstream unavailable",
      },
      { status: 502 }
    )
  }
}
