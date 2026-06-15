import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  PostUnshieldEvent,
  PostUnshieldStatus,
  PostUnshieldSummary,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "@/components/api-types"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const KRAKEN_ZEC_TICKER =
  "https://api.kraken.com/0/public/Ticker?pair=ZECUSD"
const ACTIVATION_BLOCK = 3_364_600
const ACTIVATION_TIME = "2026-06-03T04:03:08Z"
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 40
const KV_KEY_PREFIX = "zec.unshieldings.v6"
const KV_STALE_KEY_PREFIX = "zec.unshieldings.stale.v6"
const INVENTORY_KV_PREFIX = "zec.unshieldings.inventory.v1"
const INVENTORY_STALE_KV_PREFIX = "zec.unshieldings.inventory.stale.v1"
const TRACE_KV_PREFIX = "zec.unshieldings.trace.v3"
const PRICE_KV_KEY = "zec.live-price.kraken.v1"
const PRICE_KV_STALE_KEY = "zec.live-price.kraken.stale.v1"
const KV_TTL_SECONDS = 60
const PRICE_KV_TTL_SECONDS = 60
const INVENTORY_TTL_SECONDS = 60
const TRACE_STORAGE_TTL_SECONDS = 180 * 24 * 60 * 60
const TRACE_FAILURE_TTL_SECONDS = 15 * 60
const TRACE_RETRY_BACKOFF_MS = 2 * 60 * 1000
const TRACE_REQUEST_BUDGET_PER_MINUTE = 75
const TRACE_REQUESTS_PER_FLOW = 2
const TRACE_FLOW_BUDGET_PER_PASS = Math.floor(
  TRACE_REQUEST_BUDGET_PER_MINUTE / TRACE_REQUESTS_PER_FLOW
)
const TRACE_CONCURRENCY = 3
const INVENTORY_PAGE_SIZE = 100
const INVENTORY_MAX_PAGES = 100
const FOREGROUND_INVENTORY_MAX_PAGES = 2
const RESPONSE_REFRESH_AFTER_MS = 15_000

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-unshielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30",
}
const WARMING_RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=5",
}
const FORCE_REFRESH_HEADERS = {
  "Cache-Control": "no-store",
}

type PoolMode = "orchard" | "all"

interface KVLike {
  get(k: string): Promise<string | null>
  get(keys: string[]): Promise<Map<string, string | null>>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

interface RuntimeContext {
  kv: KVLike | null
  waitUntil: ((promise: Promise<unknown>) => void) | null
}

interface KrakenTickerResponse {
  error?: string[]
  result?: Record<string, { c?: string[] }>
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

interface CipherscanFlowPoint {
  date?: string
  deshield?: number
  deshieldTx?: number
}

interface CipherscanFlowsResponse {
  success?: boolean
  points?: CipherscanFlowPoint[]
}

interface AggregateTotals {
  outZec: number
  outUsd: number | null
  outTx: number
  source: string
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

interface FlowInventory {
  flows: CipherscanFlow[]
  fetchedAt: number
  complete: boolean
  nextCursor: number | null
  nextCursorId: number | null
  source: string
}

interface CachedTrace {
  trace: PostUnshieldTrace | null
  checkedAt: number
  lastAttemptAt?: number
}

interface TraceAnalysisResult {
  trace: PostUnshieldTrace | null
  refreshed: boolean
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

function parseSort(request: Request): UnshieldingSort {
  return new URL(request.url).searchParams.get("sort") === "largest"
    ? "largest"
    : "recent"
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

async function getRuntime(): Promise<RuntimeContext> {
  try {
    const cf = await getCloudflareContext({ async: true })
    return {
      kv:
        (cf?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null,
      waitUntil:
        typeof cf?.ctx?.waitUntil === "function"
          ? cf.ctx.waitUntil.bind(cf.ctx)
          : null,
    }
  } catch {
    return { kv: null, waitUntil: null }
  }
}

function cacheKey(
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  cursor: number | null,
  cursorId: number | null
) {
  return `${KV_KEY_PREFIX}.${pool}.${period}.${sort}.${limit}.${
    cursor ?? "head"
  }.${cursorId ?? "head"}`
}

function staleCacheKey(key: string) {
  return key.replace(KV_KEY_PREFIX, KV_STALE_KEY_PREFIX)
}

function inventoryKey(pool: PoolMode) {
  return `${INVENTORY_KV_PREFIX}.${pool}`
}

function staleInventoryKey(pool: PoolMode) {
  return `${INVENTORY_STALE_KV_PREFIX}.${pool}`
}

function traceKey(flow: CipherscanFlow) {
  const address = flow.addresses?.find(Boolean) ?? "unknown"
  return `${TRACE_KV_PREFIX}.${flow.txid ?? flow.id ?? "unknown"}.${address}`
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

function flowsUrl(pool: PoolMode): URL {
  const url = new URL(`${CIPHERSCAN}/pools/flows`)
  url.searchParams.set("period", "90d")
  url.searchParams.set("granularity", "hourly")
  if (pool === "orchard") url.searchParams.set("pool", "orchard")
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

function flowTimeMs(flow: CipherscanFlow): number | null {
  return typeof flow.blockTime === "number" && Number.isFinite(flow.blockTime)
    ? flow.blockTime * 1000
    : null
}

function flowIdentity(flow: CipherscanFlow): string {
  return `${flow.txid ?? flow.id ?? "unknown"}:${
    flow.addresses?.find(Boolean) ?? ""
  }`
}

function parseInventory(raw: string | null): FlowInventory | null {
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

async function readInventory(
  kv: KVLike | null,
  key: string
): Promise<FlowInventory | null> {
  if (!kv) return null
  try {
    return parseInventory(await kv.get(key))
  } catch {
    return null
  }
}

function inventoryCovers(inventory: FlowInventory, cutoffMs: number): boolean {
  if (inventory.complete) return true
  const oldest = inventory.flows[inventory.flows.length - 1]
  const oldestMs = oldest ? flowTimeMs(oldest) : null
  return oldestMs != null && oldestMs <= cutoffMs
}

async function refreshInventory(
  pool: PoolMode,
  existing: FlowInventory | null,
  requestedCutoffMs: number,
  maxPages = INVENTORY_MAX_PAGES
): Promise<FlowInventory> {
  const activationMs = Date.parse(ACTIVATION_TIME)
  const targetCutoffMs = Math.max(activationMs, requestedCutoffMs)
  const known = new Set((existing?.flows ?? []).map(flowIdentity))
  const collected: CipherscanFlow[] = [...(existing?.flows ?? [])]
  let complete = existing?.complete ?? false
  let nextCursor = existing?.nextCursor ?? null
  let nextCursorId = existing?.nextCursorId ?? null
  let source = listUrl(pool, INVENTORY_PAGE_SIZE, null, null).toString()

  if (existing) {
    let cursor: number | null = null
    let cursorId: number | null = null
    let reachedKnown = false
    for (let page = 0; page < maxPages && !reachedKnown; page += 1) {
      const url = listUrl(pool, INVENTORY_PAGE_SIZE, cursor, cursorId)
      source = url.toString()
      const json = await fetchJson<CipherscanListResponse>(url)
      const rows = json.flows ?? []
      if (rows.length === 0) break
      for (const flow of rows) {
        if (flow.flowType !== "deshield") continue
        if (known.has(flowIdentity(flow))) {
          reachedKnown = true
          break
        }
        collected.push(flow)
      }
      if (reachedKnown || !json.pagination?.hasNext) break
      cursor = json.pagination.nextCursor ?? null
      cursorId = json.pagination.nextCursorId ?? null
    }
  }

  const currentInventory: FlowInventory = {
    flows: collected
      .filter((flow) => {
        const ms = flowTimeMs(flow)
        return ms == null || ms >= activationMs
      })
      .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)),
    fetchedAt: Date.now(),
    complete,
    nextCursor,
    nextCursorId,
    source,
  }

  if (!existing || !inventoryCovers(currentInventory, targetCutoffMs)) {
    let cursor = existing ? nextCursor : null
    let cursorId = existing ? nextCursorId : null
    for (let page = 0; page < maxPages; page += 1) {
      const url = listUrl(pool, INVENTORY_PAGE_SIZE, cursor, cursorId)
      source = url.toString()
      const json = await fetchJson<CipherscanListResponse>(url)
      const rows = json.flows ?? []
      if (rows.length === 0) {
        complete = true
        nextCursor = null
        nextCursorId = null
        break
      }
      for (const flow of rows) {
        if (flow.flowType !== "deshield") continue
        const ms = flowTimeMs(flow)
        if (ms != null && ms < activationMs) {
          complete = true
          break
        }
        collected.push(flow)
      }
      if (complete || !json.pagination?.hasNext) {
        complete = true
        nextCursor = null
        nextCursorId = null
      } else {
        nextCursor = json.pagination.nextCursor ?? null
        nextCursorId = json.pagination.nextCursorId ?? null
      }

      const oldestMs = rows.reduce<number | null>((oldest, flow) => {
        const ms = flowTimeMs(flow)
        return ms == null ? oldest : oldest == null ? ms : Math.min(oldest, ms)
      }, null)
      if (complete || (oldestMs != null && oldestMs <= targetCutoffMs)) break
      cursor = nextCursor
      cursorId = nextCursorId
    }
  }

  const byIdentity = new Map<string, CipherscanFlow>()
  for (const flow of collected) {
    const id = flowIdentity(flow)
    if (!byIdentity.has(id)) byIdentity.set(id, flow)
  }
  return {
    flows: [...byIdentity.values()]
      .filter((flow) => {
        const ms = flowTimeMs(flow)
        return ms == null || ms >= activationMs
      })
      .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)),
    fetchedAt: Date.now(),
    complete,
    nextCursor,
    nextCursorId,
    source,
  }
}

async function loadInventory(
  pool: PoolMode,
  kv: KVLike | null,
  forceRefresh: boolean,
  cutoffMs: number,
  allowStaleInventory = false,
  maxPages = INVENTORY_MAX_PAGES
): Promise<FlowInventory> {
  if (!forceRefresh) {
    const fresh = await readInventory(kv, inventoryKey(pool))
    if (fresh && inventoryCovers(fresh, cutoffMs)) return fresh
  }

  const stale = await readInventory(kv, staleInventoryKey(pool))
  if (!forceRefresh && allowStaleInventory && stale && inventoryCovers(stale, cutoffMs)) {
    return stale
  }
  try {
    const inventory = await refreshInventory(pool, stale, cutoffMs, maxPages)
    if (kv) {
      await Promise.all([
        kv.put(inventoryKey(pool), JSON.stringify(inventory), {
          expirationTtl: INVENTORY_TTL_SECONDS,
        }),
        kv.put(staleInventoryKey(pool), JSON.stringify(inventory)),
      ])
    }
    return inventory
  } catch (error) {
    if (stale) return stale
    throw error
  }
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

async function fetchLiveZecPrice(
  kv: KVLike | null,
  waitUntil: ((promise: Promise<unknown>) => void) | null,
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

async function fetchAggregateTotals(
  pool: PoolMode,
  cutoffMs: number,
  priceUsd: number | null
): Promise<AggregateTotals | null> {
  const url = flowsUrl(pool)
  try {
    const json = await fetchJson<CipherscanFlowsResponse>(url)
    const points = Array.isArray(json.points) ? json.points : []
    let outZec = 0
    let outTx = 0
    for (const point of points) {
      const key = point.date
      const ms = key ? Date.parse(key) : NaN
      if (!Number.isFinite(ms) || ms < cutoffMs) continue
      outZec += typeof point.deshield === "number" ? point.deshield : 0
      outTx += typeof point.deshieldTx === "number" ? point.deshieldTx : 0
    }
    return {
      outZec: round(outZec),
      outUsd: priceUsd != null ? round(outZec * priceUsd, 2) : null,
      outTx,
      source: url.toString(),
    }
  } catch {
    return null
  }
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
  if (!txOutput && !addressDetail) return null
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

function parseCachedTrace(raw: string | null): CachedTrace | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedTrace
    const validTrace = parsed?.trace === null || Boolean(parsed?.trace?.hash)
    return validTrace && typeof parsed.checkedAt === "number" ? parsed : null
  } catch {
    return null
  }
}

function repriceTrace(
  trace: PostUnshieldTrace,
  priceUsd: number | null
): PostUnshieldTrace {
  return {
    ...trace,
    amountUsd:
      priceUsd != null ? round(trace.amountZec * priceUsd, 2) : trace.amountUsd,
  }
}

function isTerminalTrace(trace: PostUnshieldTrace): boolean {
  return (
    trace.status === "reshielded" ||
    (trace.status === "spent" && trace.nextSpend != null)
  )
}

function traceRefreshIntervalMs(trace: PostUnshieldTrace, now: number): number {
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

function isCachedTraceStale(cached: CachedTrace, now: number): boolean {
  if (!cached.trace) return false
  if (isTerminalTrace(cached.trace)) return false
  if (now - cached.checkedAt < traceRefreshIntervalMs(cached.trace, now)) {
    return false
  }
  const lastAttemptAt = cached.lastAttemptAt ?? cached.checkedAt
  return now - lastAttemptAt >= TRACE_RETRY_BACKOFF_MS
}

function shouldPreserveCachedTrace(
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

function mergeTraceEvidence(
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

async function readCachedTraces(
  flows: CipherscanFlow[],
  kv: KVLike | null,
  priceUsd: number | null,
  bypass = new Set<string>()
) {
  const traces = new Map<string, PostUnshieldTrace>()
  const entries = new Map<string, CachedTrace>()
  const misses: CipherscanFlow[] = []
  const stale: CipherscanFlow[] = []
  if (!kv || flows.length === 0) {
    return { traces, entries, misses: [...flows], stale }
  }

  const now = Date.now()
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

    for (let index = 0; index < batch.length; index += 1) {
      const flow = batch[index]
      const key = keys[index]
      const cached = parseCachedTrace(values.get(key) ?? null)
      if (!cached) {
        misses.push(flow)
        continue
      }
      const identity = flowIdentity(flow)
      entries.set(identity, cached)
      if (!cached.trace) {
        const lastAttemptAt = cached.lastAttemptAt ?? cached.checkedAt
        if (now - lastAttemptAt >= TRACE_RETRY_BACKOFF_MS) {
          misses.push(flow)
        }
        continue
      }
      traces.set(identity, repriceTrace(cached.trace, priceUsd))
      if (bypass.has(key) || isCachedTraceStale(cached, now)) {
        stale.push(flow)
      }
    }
  }

  return { traces, entries, misses, stale }
}

async function mapWithConcurrency<T, R>(
  rows: T[],
  concurrency: number,
  worker: (row: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(rows.length)
  let next = 0
  async function run() {
    while (next < rows.length) {
      const index = next
      next += 1
      results[index] = await worker(rows[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, () => run())
  )
  return results
}

async function analyzeAndCacheFlows(
  flows: CipherscanFlow[],
  kv: KVLike | null,
  priceUsd: number | null,
  cachedEntries = new Map<string, CachedTrace>()
): Promise<TraceAnalysisResult[]> {
  if (flows.length === 0) return []
  return mapWithConcurrency(
    flows,
    TRACE_CONCURRENCY,
    async (flow) => {
      const identity = flowIdentity(flow)
      const previous = cachedEntries.get(identity) ?? null
      const candidate = await traceFlow(flow, priceUsd)
      if (!candidate) {
        const now = Date.now()
        if (kv) {
          try {
            const failed: CachedTrace = {
              trace: previous?.trace ?? null,
              checkedAt: previous?.checkedAt ?? now,
              lastAttemptAt: now,
            }
            await kv.put(traceKey(flow), JSON.stringify(failed), {
              expirationTtl: previous?.trace
                ? TRACE_STORAGE_TTL_SECONDS
                : TRACE_FAILURE_TTL_SECONDS,
            })
          } catch {}
        }
        return {
          trace: previous?.trace
            ? repriceTrace(previous.trace, priceUsd)
            : null,
          refreshed: false,
        }
      }

      const previousTrace = previous?.trace ?? null
      const preservePrevious =
        previousTrace != null &&
        shouldPreserveCachedTrace(previousTrace, candidate)
      const trace = preservePrevious
        ? previousTrace
        : mergeTraceEvidence(previousTrace, candidate)
      const now = Date.now()
      if (kv) {
        try {
          const cached: CachedTrace = preservePrevious
            ? {
                trace: previousTrace,
                checkedAt: previous?.checkedAt ?? now,
                lastAttemptAt: now,
              }
            : { trace, checkedAt: now, lastAttemptAt: now }
          await kv.put(traceKey(flow), JSON.stringify(cached), {
            expirationTtl: TRACE_STORAGE_TTL_SECONDS,
          })
        } catch {}
      }
      return {
        trace: repriceTrace(trace, priceUsd),
        refreshed: !preservePrevious,
      }
    }
  )
}

function isResponse(payload: UnshieldingsResponse | null): payload is UnshieldingsResponse {
  return (
    payload?.postUnshield?.summary != null &&
    payload.pagination != null &&
    payload.analysis != null
  )
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

function repricePayload(
  payload: UnshieldingsResponse,
  priceUsd: number | null
): UnshieldingsResponse {
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return payload
  }
  return {
    ...payload,
    totals: {
      ...payload.totals,
      outUsd: round(payload.totals.outZec * priceUsd, 2),
    },
    postUnshield: {
      summary: payload.postUnshield.summary,
      traces: payload.postUnshield.traces.map((trace) =>
        repriceTrace(trace, priceUsd)
      ),
    },
  }
}

async function writeResponseCache(
  kv: KVLike,
  key: string,
  payload: UnshieldingsResponse
) {
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(key, json, { expirationTtl: KV_TTL_SECONDS }),
    kv.put(staleCacheKey(key), json),
  ])
}

async function buildResponse(
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  cursor: number | null,
  priceUsd: number | null,
  kv: KVLike | null,
  forceRefresh: boolean,
  allowStaleInventory = false,
  inventoryMaxPages = INVENTORY_MAX_PAGES
): Promise<{
  payload: UnshieldingsResponse
  warmFlows: CipherscanFlow[]
  warmCachedEntries: Map<string, CachedTrace>
}> {
  const cutoffMs = periodCutoff(period)
  const [inventory, aggregate] = await Promise.all([
    loadInventory(
      pool,
      kv,
      forceRefresh,
      cutoffMs,
      allowStaleInventory,
      inventoryMaxPages
    ),
    fetchAggregateTotals(pool, cutoffMs, priceUsd),
  ])
  const windowFlows = inventory.flows
    .filter((flow) => {
      const ms = flowTimeMs(flow)
      return ms != null && ms >= cutoffMs
    })
    .sort((a, b) => {
      if (sort === "largest") {
        const amountDiff = (b.amountZec ?? 0) - (a.amountZec ?? 0)
        if (amountDiff !== 0) return amountDiff
      }
      return (b.blockTime ?? 0) - (a.blockTime ?? 0)
    })
  const offset = Math.max(0, cursor ?? 0)
  const pageFlows = windowFlows.slice(offset, offset + limit)
  const forcePageKeys = forceRefresh
    ? new Set(pageFlows.map(traceKey))
    : new Set<string>()
  const cached = await readCachedTraces(
    windowFlows,
    kv,
    priceUsd,
    forcePageKeys
  )
  const analyzedByFlow = new Map(cached.traces)
  const pageIdentities = new Set(pageFlows.map(flowIdentity))
  const pageRefreshIdentities = new Set(
    [...cached.misses, ...cached.stale]
      .filter((flow) => pageIdentities.has(flowIdentity(flow)))
      .map(flowIdentity)
  )
  const pageRefreshFlows = pageFlows
    .filter((flow) => pageRefreshIdentities.has(flowIdentity(flow)))
    .slice(0, TRACE_FLOW_BUDGET_PER_PASS)
  const pageResults = await analyzeAndCacheFlows(
    pageRefreshFlows,
    kv,
    priceUsd,
    cached.entries
  )
  const refreshedIdentities = new Set<string>()
  for (const result of pageResults) {
    const trace = result.trace
    if (!trace) continue
    const flow = pageFlows.find(
      (candidate) =>
        candidate.txid === trace.hash &&
        candidate.addresses?.includes(trace.address)
    )
    if (flow) {
      const identity = flowIdentity(flow)
      analyzedByFlow.set(identity, trace)
      if (result.refreshed) refreshedIdentities.add(identity)
    }
  }

  const pageTraces = pageFlows
    .map((flow) => analyzedByFlow.get(flowIdentity(flow)) ?? null)
    .filter((trace): trace is PostUnshieldTrace => trace != null)
  const analyzedWindow = windowFlows
    .map((flow) => analyzedByFlow.get(flowIdentity(flow)) ?? null)
    .filter((trace): trace is PostUnshieldTrace => trace != null)
  const analyzedIdentities = new Set(analyzedByFlow.keys())
  const unresolvedMisses = cached.misses.filter(
    (flow) => !analyzedIdentities.has(flowIdentity(flow))
  )
  const staleAfterPage = cached.stale.filter(
    (flow) => !refreshedIdentities.has(flowIdentity(flow))
  )
  const pageRefreshSet = new Set(pageRefreshFlows.map(flowIdentity))
  const backgroundFlowBudget = Math.max(
    0,
    TRACE_FLOW_BUDGET_PER_PASS - pageRefreshFlows.length
  )
  const warmFlows = [...staleAfterPage, ...unresolvedMisses]
    .filter((flow) => !pageRefreshSet.has(flowIdentity(flow)))
    .filter(
      (flow, index, rows) =>
        rows.findIndex(
          (candidate) => flowIdentity(candidate) === flowIdentity(flow)
        ) === index
    )
    .slice(0, backgroundFlowBudget)
  const staleIdentities = new Set(staleAfterPage.map(flowIdentity))
  const refreshing = warmFlows.filter((flow) =>
    staleIdentities.has(flowIdentity(flow))
  ).length
  const warmCachedEntries = new Map<string, CachedTrace>()
  for (const flow of warmFlows) {
    const identity = flowIdentity(flow)
    const entry = cached.entries.get(identity)
    if (entry) warmCachedEntries.set(identity, entry)
  }
  const inventoryOutZec = round(
    windowFlows.reduce(
      (sum, flow) =>
        sum +
        (typeof flow.amountZec === "number" && Number.isFinite(flow.amountZec)
          ? flow.amountZec
          : 0),
      0
    )
  )
  const aggregateUsable = aggregate != null && (aggregate.outTx > 0 || windowFlows.length === 0)
  const outZec = aggregateUsable ? aggregate.outZec : inventoryOutZec
  const outTx = aggregateUsable ? aggregate.outTx : windowFlows.length
  const analyzed = analyzedWindow.length
  const remaining = Math.max(0, outTx - analyzed)
  const inventoryComplete = inventoryCovers(inventory, cutoffMs)
  const complete = inventoryComplete && windowFlows.length >= outTx && remaining === 0
  const nextOffset = offset + pageFlows.length

  const payload: UnshieldingsResponse = {
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
      warming: kv != null && !complete,
      cacheHits: cached.traces.size,
      inventoryComplete,
      refreshing,
    },
    pagination: {
      limit,
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
        ? refreshing > 0
          ? `Cached outcome counts cover the full window; ${refreshing} open outcomes are being refreshed.`
          : "Outcome counts cover every deshield transaction in the selected window."
        : `Outcome cache covers ${analyzed} of ${outTx} transactions and is warming in the background.`,
      "RESHIELD means the same transparent address later moved value into a shielded-touching tx.",
      "SPENT excludes detected reshields and does not prove exchange sale.",
    ],
  }

  return { payload, warmFlows, warmCachedEntries }
}

function responseNeedsWarm(payload: UnshieldingsResponse): boolean {
  if (Date.now() - payload.fetchedAt < RESPONSE_REFRESH_AFTER_MS) return false
  return !payload.analysis.complete || payload.analysis.refreshing > 0
}

function responseHeaders(payload: UnshieldingsResponse) {
  return payload.analysis.complete && payload.analysis.refreshing === 0
    ? RESPONSE_HEADERS
    : WARMING_RESPONSE_HEADERS
}

async function refreshResponseCache(
  key: string,
  pool: PoolMode,
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  cursor: number | null,
  priceUsd: number | null,
  kv: KVLike
) {
  const { payload, warmFlows, warmCachedEntries } = await buildResponse(
    pool,
    period,
    sort,
    limit,
    cursor,
    priceUsd,
    kv,
    false
  )
  await writeResponseCache(kv, key, payload)
  if (warmFlows.length > 0) {
    await analyzeAndCacheFlows(
      warmFlows,
      kv,
      priceUsd,
      warmCachedEntries
    ).catch(() => [])
  }
}

export async function GET(request: Request) {
  const pool = parsePool(request)
  const period = parsePeriod(request)
  const sort = parseSort(request)
  const limit = parseLimit(request)
  const { cursor, cursorId } = parseCursor(request)
  const forceRefresh = shouldForceRefresh(request)
  const runtime = await getRuntime()
  const kv = runtime.kv
  const key = cacheKey(pool, period, sort, limit, cursor, cursorId)
  const priceUsd = await fetchLiveZecPrice(kv, runtime.waitUntil, forceRefresh)

  if (kv && !forceRefresh) {
    try {
      const cached = parseCachedPayload(await kv.get(key))
      if (cached) {
        if (responseNeedsWarm(cached) && runtime.waitUntil) {
          runtime.waitUntil(
            refreshResponseCache(
              key,
              pool,
              period,
              sort,
              limit,
              cursor,
              priceUsd,
              kv
            ).catch(() => null)
          )
        }
        const repriced = repricePayload(cached, priceUsd)
        return NextResponse.json(repriced, { headers: responseHeaders(repriced) })
      }
      const stale = parseCachedPayload(await kv.get(staleCacheKey(key)))
      if (stale) {
        if (runtime.waitUntil && responseNeedsWarm(stale)) {
          runtime.waitUntil(
            refreshResponseCache(
              key,
              pool,
              period,
              sort,
              limit,
              cursor,
              priceUsd,
              kv
            ).catch(() => null)
          )
        }
        return NextResponse.json(
          { ...repricePayload(stale, priceUsd), stale: true },
          { headers: WARMING_RESPONSE_HEADERS }
        )
      }
    } catch {}
  }

  try {
    const { payload, warmFlows, warmCachedEntries } = await buildResponse(
      pool,
      period,
      sort,
      limit,
      cursor,
      priceUsd,
      kv,
      forceRefresh,
      !forceRefresh,
      forceRefresh ? INVENTORY_MAX_PAGES : FOREGROUND_INVENTORY_MAX_PAGES
    )
    if (kv) {
      try {
        await writeResponseCache(kv, key, payload)
      } catch {}
    }
    if (kv && warmFlows.length > 0 && runtime.waitUntil) {
      runtime.waitUntil(
        analyzeAndCacheFlows(
          warmFlows,
          kv,
          priceUsd,
          warmCachedEntries
        ).catch(() => [])
      )
    }
    const headers = forceRefresh
      ? FORCE_REFRESH_HEADERS
      : responseHeaders(payload)
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
