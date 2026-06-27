import type {
  CipherscanFlow,
} from "./cipherscan"
import type {
  PostUnshieldEvent,
  PostUnshieldStatus,
  PostUnshieldSummary,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "@/components/api-types"

export const ACTIVATION_BLOCK = 3_364_600
export const ACTIVATION_TIME = "2026-06-03T04:03:08Z"

export const DEFAULT_LIMIT = 24
export const MAX_LIMIT = 40

export const KV_KEY_PREFIX = "zec.unshieldings.v8"
export const KV_STALE_KEY_PREFIX = "zec.unshieldings.stale.v8"
export const INVENTORY_KV_PREFIX = "zec.unshieldings.inventory.v1"
export const PROGRESS_KV_PREFIX = "zec.unshieldings.progress.v1"
// All deshield traces for a pool live in a single blob keyed by flow identity.
// This collapses what used to be one KV key per trace (thousands of reads per
// full-inventory scan) into a single read. The blob is rewritten by the cron
// each minute; size stays well under KV's 25MB value limit.
export const TRACE_BLOB_KV_PREFIX = "zec.unshieldings.traces.blob.v1"
export const PRICE_KV_KEY = "zec.live-price.kraken.v1"
export const PRICE_KV_STALE_KEY = "zec.live-price.kraken.stale.v1"

export const KV_TTL_SECONDS = 60
export const PRICE_KV_TTL_SECONDS = 60
// Response caches are rolling views over a growing head inventory. Keep both
// complete and warming responses short-lived; the stale mirror is the fallback.
// The cron rebuilds every preset each minute, so these TTLs only need to cover
// the gap between cron runs.
export const COMPLETE_RESPONSE_CACHE_TTL_SECONDS = 90
export const WARMING_RESPONSE_CACHE_TTL_SECONDS = 90
// Keep the full deshield inventory around longer than the short response cache.
// Response freshness is controlled separately by KV_TTL_SECONDS and
// INVENTORY_REFRESH_MS; expiring inventory too quickly forces cold rebuilds
// after quiet periods.
export const INVENTORY_TTL_SECONDS = 7 * 24 * 60 * 60
export const TRACE_STORAGE_TTL_SECONDS = 180 * 24 * 60 * 60
export const TRACE_RETRY_BACKOFF_MS = 2 * 60 * 1000

export const INVENTORY_PAGE_SIZE = 100
export const INVENTORY_REFRESH_MS = 5 * 60 * 1000

// How old a cached response may be before the HTTP path fires a background
// SWR rebuild. Rebuilds are cheap now (one blob read + two writes, no
// per-trace reads), so this demand-driven refresh keeps presets fresh without
// the cron having to build all 24 presets per tick.
export const RESPONSE_REFRESH_AFTER_MS = 30_000

export const KRAKEN_ZEC_TICKER =
  "https://api.kraken.com/0/public/Ticker?pair=ZECUSD"

export const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-unshielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

export const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30",
}
export const WARMING_RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
}
export const FORCE_REFRESH_HEADERS = {
  "Cache-Control": "no-store",
}

export type PoolMode = "orchard" | "sapling" | "all"

export const PERIODS: UnshieldingPeriod[] = ["1h", "12h", "1d", "1w", "1m", "all"]
export const SORTS: UnshieldingSort[] = ["recent", "largest"]

export interface KVLike {
  get(k: string): Promise<string | null>
  get(keys: string[]): Promise<Map<string, string | null>>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

export interface KrakenTickerResponse {
  error?: string[]
  result?: Record<string, { c?: string[] }>
}

export interface FlowInventory {
  flows: CipherscanFlow[]
  fetchedAt: number
  headFetchedAt?: number
  complete: boolean
  nextCursor: number | null
  nextCursorId: number | null
  source: string
}

export interface CachedTrace {
  trace: PostUnshieldTrace | null
  checkedAt: number
  lastAttemptAt?: number
}

export interface ClassificationProgress {
  total: number
  classified: number
  lastRunAt: number
  complete: boolean
  scanOffset?: number
}

export function round(n: number, places = 8): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

export function zatoshiToZec(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === "string" ? Number(value) : value
  return Number.isFinite(n) ? round(n / 100_000_000) : null
}

export function secondsToIso(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const n = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

export function flowTimeMs(flow: CipherscanFlow): number | null {
  return typeof flow.blockTime === "number" && Number.isFinite(flow.blockTime)
    ? flow.blockTime * 1000
    : null
}

export function flowIdentity(flow: CipherscanFlow): string {
  return `${flow.txid ?? flow.id ?? "unknown"}:${
    flow.addresses?.find(Boolean) ?? ""
  }`
}

export function inventoryKey(pool: PoolMode) {
  return `${INVENTORY_KV_PREFIX}.${pool}`
}

export function progressKey(pool: PoolMode) {
  return `${PROGRESS_KV_PREFIX}.${pool}`
}

export function traceBlobKey(pool: PoolMode) {
  return `${TRACE_BLOB_KV_PREFIX}.${pool}`
}

export interface TraceBlob {
  traces: Record<string, CachedTrace>
  updatedAt: number
}

export function isValidCachedTrace(value: unknown): value is CachedTrace {
  if (!value || typeof value !== "object") return false
  const v = value as CachedTrace
  return (
    typeof v.checkedAt === "number" &&
    (v.trace == null || Boolean(v.trace?.hash))
  )
}

/** Parse the single trace blob for a pool into an identity -> CachedTrace map. */
export function parseTraceBlob(raw: string | null): Map<string, CachedTrace> {
  const map = new Map<string, CachedTrace>()
  if (!raw) return map
  try {
    const parsed = JSON.parse(raw) as TraceBlob
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return map
    }
    const traces = parsed.traces
    if (!traces || typeof traces !== "object") return map
    for (const [identity, cached] of Object.entries(traces)) {
      if (isValidCachedTrace(cached)) map.set(identity, cached)
    }
  } catch {}
  return map
}

export function responseCacheKey(
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  cursor: number | null = null
) {
  const cursorKey = cursor == null || cursor <= 0 ? "head" : String(cursor)
  return `${KV_KEY_PREFIX}.${pool}.${period}.${sort}.${limit}.${cursorKey}.head`
}

export function staleResponseCacheKey(key: string) {
  return key.replace(KV_KEY_PREFIX, KV_STALE_KEY_PREFIX)
}

export function parsePool(request: Request): PoolMode {
  const pool = new URL(request.url).searchParams.get("pool")
  if (pool === "all" || pool === "sapling") return pool
  return "orchard"
}

export function parsePeriod(request: Request): UnshieldingPeriod {
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

export function parseSort(request: Request): UnshieldingSort {
  return new URL(request.url).searchParams.get("sort") === "largest"
    ? "largest"
    : "recent"
}

export function parseLimit(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get("limit"))
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)))
}

export function parseCursor(request: Request): {
  cursor: number | null
  cursorId: number | null
} {
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

export function periodCutoff(period: UnshieldingPeriod): number {
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

export function inventoryCovers(inventory: FlowInventory, cutoffMs: number): boolean {
  if (inventory.complete) return true
  const oldest = inventory.flows[inventory.flows.length - 1]
  const oldestMs = oldest ? flowTimeMs(oldest) : null
  return oldestMs != null && oldestMs <= cutoffMs
}

export function parsePositiveNumber(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function extractKrakenPrice(json: KrakenTickerResponse): number | null {
  if (json.error?.length) return null
  const firstPair = Object.values(json.result ?? {})[0]
  const price = firstPair?.c?.[0] ? Number(firstPair.c[0]) : null
  return price != null && Number.isFinite(price) && price > 0 ? price : null
}

async function refreshLiveZecPrice(kv: KVLike | null): Promise<number | null> {
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

export async function fetchLiveZecPrice(
  kv: KVLike | null,
  waitUntil: ((promise: Promise<unknown>) => void) | null = null,
  forceRefresh = false
): Promise<number | null> {
  if (kv) {
    try {
      const cached = !forceRefresh
        ? parsePositiveNumber(await kv.get(PRICE_KV_KEY))
        : null
      if (cached != null) return cached
      const stale = !forceRefresh
        ? parsePositiveNumber(await kv.get(PRICE_KV_STALE_KEY))
        : null
      if (stale != null) {
        waitUntil?.(refreshLiveZecPrice(kv).catch(() => null))
        return stale
      }
    } catch {}
  }
  return refreshLiveZecPrice(kv)
}

export function addressTxToEvent(tx: {
  txid?: string
  blockHeight?: number
  blockTime?: string | number
  hasSapling?: boolean
  hasOrchard?: boolean
  hasSprout?: boolean
  inputValue?: number
  netChange?: number
}): PostUnshieldEvent | null {
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

export function touchesShieldedPool(tx: {
  hasOrchard?: boolean
  hasSapling?: boolean
  hasSprout?: boolean
}): boolean {
  return Boolean(tx.hasOrchard || tx.hasSapling || tx.hasSprout)
}

export function isOutgoingTx(tx: {
  inputValue?: number
  netChange?: number
}): boolean {
  return (tx.inputValue ?? 0) > 0 || (tx.netChange ?? 0) < 0
}

export function reshieldType(
  reshield: PostUnshieldEvent | null,
  deshieldAmountZec: number
): "full" | "partial" | null {
  if (!reshield || deshieldAmountZec <= 0) return null
  return reshield.amountZec >= deshieldAmountZec * 0.995 ? "full" : "partial"
}

export function emptySummary(): PostUnshieldSummary {
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

export function summarizeTraces(traces: PostUnshieldTrace[]): PostUnshieldSummary {
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

export function isTerminalTrace(trace: PostUnshieldTrace): boolean {
  return (
    trace.status === "reshielded" ||
    (trace.status === "spent" && trace.nextSpend != null)
  )
}

export function traceRefreshIntervalMs(
  trace: PostUnshieldTrace,
  now: number
): number {
  const traceMs = Date.parse(trace.time)
  const ageMs = Number.isFinite(traceMs)
    ? Math.max(0, now - traceMs)
    : 30 * 24 * 60 * 60 * 1000

  if (trace.status === "unknown") {
    if (ageMs <= 6 * 60 * 60 * 1000) return 2 * 60 * 1000
    if (ageMs <= 24 * 60 * 60 * 1000) return 10 * 60 * 1000
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000
    return 6 * 60 * 60 * 1000
  }

  if (ageMs <= 6 * 60 * 60 * 1000) return 5 * 60 * 1000
  if (ageMs <= 24 * 60 * 60 * 1000) return 15 * 60 * 1000
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000
  return 6 * 60 * 60 * 1000
}

export function isCachedTraceStale(cached: CachedTrace, now: number): boolean {
  if (!cached.trace) return false
  if (isTerminalTrace(cached.trace)) return false
  if (now - cached.checkedAt < traceRefreshIntervalMs(cached.trace, now)) {
    return false
  }
  const lastAttemptAt = cached.lastAttemptAt ?? cached.checkedAt
  return now - lastAttemptAt >= TRACE_RETRY_BACKOFF_MS
}

export function shouldPreserveCachedTrace(
  previous: PostUnshieldTrace,
  candidate: PostUnshieldTrace
): boolean {
  if (previous.status === "reshielded" && candidate.status !== "reshielded") {
    return true
  }
  if (isTerminalTrace(previous) && !isTerminalTrace(candidate)) return true
  if (candidate.status === "unknown" && previous.status !== "unknown") return true
  if (previous.status === "reused" && candidate.status === "held") return true
  if (
    previous.outputSpent === true &&
    candidate.outputSpent !== true &&
    candidate.nextSpend == null
  ) {
    return true
  }
  return false
}

export function mergeTraceEvidence(
  previous: PostUnshieldTrace | null,
  candidate: PostUnshieldTrace
): PostUnshieldTrace {
  if (!previous) return candidate
  return {
    ...candidate,
    outputSpent: candidate.outputSpent ?? previous.outputSpent,
    balanceZec: candidate.balanceZec ?? previous.balanceZec,
    totalReceivedZec:
      candidate.totalReceivedZec ?? previous.totalReceivedZec,
    totalSentZec: candidate.totalSentZec ?? previous.totalSentZec,
    txCount: candidate.txCount ?? previous.txCount,
    lastSeen: candidate.lastSeen ?? previous.lastSeen,
    priorShieldSource:
      candidate.priorShieldSource ?? previous.priorShieldSource,
  }
}



export function parseInventory(raw: string | null): FlowInventory | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as FlowInventory
    return Array.isArray(parsed.flows) && typeof parsed.fetchedAt === "number"
      ? parsed
      : null
  } catch {
    return null
  }
}

export function parseProgress(raw: string | null): ClassificationProgress | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ClassificationProgress
    if (
      typeof parsed.total === "number" &&
      typeof parsed.classified === "number" &&
      typeof parsed.lastRunAt === "number" &&
      typeof parsed.complete === "boolean"
    ) {
      return {
        ...parsed,
        scanOffset:
          typeof parsed.scanOffset === "number" && parsed.scanOffset >= 0
            ? parsed.scanOffset
            : undefined,
      }
    }
  } catch {}
  return null
}
