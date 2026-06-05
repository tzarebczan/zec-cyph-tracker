import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  ShieldingBlockBucket,
  ShieldingBucket,
  ShieldingDetailsResponse,
  ShieldingFlowTotals,
  ShieldingTransfer,
  ShieldingTransferOutput,
} from "@/components/api-types"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const KRAKEN_ZEC_TICKER =
  "https://api.kraken.com/0/public/Ticker?pair=ZECUSD"
const ACTIVATION_BLOCK = 3_364_600
const ACTIVATION_TIME = "2026-06-03T04:03:08Z"

const FLOW_PERIOD = "90d"
const RECENT_FLOW_LIMIT = 100
const RECENT_DETAIL_LIMIT = 40
const KV_KEY_PREFIX = "zec.shielding-details.v3"
const KV_STALE_KEY_PREFIX = "zec.shielding-details.stale.v3"
const PRICE_KV_KEY = "zec.live-price.kraken.v1"
const PRICE_KV_STALE_KEY = "zec.live-price.kraken.stale.v1"
const KV_TTL_SECONDS = 5 * 60
const PRICE_KV_TTL_SECONDS = 60
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-shielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
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

type WaitUntil = (promise: Promise<unknown>) => void

interface RuntimeBindings {
  kv: KVLike | null
  waitUntil: WaitUntil | null
}

const refreshInFlight = new Map<PoolMode, Promise<void>>()

interface KrakenTickerResponse {
  error?: string[]
  result?: Record<string, { c?: string[] }>
}

interface CipherscanFlowPoint {
  date?: string
  shield?: number
  deshield?: number
  shieldTx?: number
  deshieldTx?: number
  net?: number
}

interface CipherscanFlowsResponse {
  success?: boolean
  period?: string
  pool?: string
  granularity?: "hourly" | "daily"
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
    hasPrev?: boolean
    nextCursor?: number
    nextCursorId?: number
    prevCursor?: number
    prevCursorId?: number
  }
}

interface PrivacyStatsResponse {
  totals?: {
    blocks?: number
  }
  lastUpdated?: string
  lastBlockScanned?: number
}

class UpstreamError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function parsePool(request: Request): PoolMode {
  const pool = new URL(request.url).searchParams.get("pool")
  return pool === "all" ? "all" : "orchard"
}

function kvKey(pool: PoolMode) {
  return `${KV_KEY_PREFIX}.${pool}`
}

function staleKvKey(pool: PoolMode) {
  return `${KV_STALE_KEY_PREFIX}.${pool}`
}

async function getRuntimeBindings(): Promise<RuntimeBindings> {
  try {
    const cf = await getCloudflareContext({ async: true })
    return {
      kv:
        (cf?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null,
      waitUntil:
        typeof cf?.ctx?.waitUntil === "function"
          ? (promise) => cf.ctx.waitUntil(promise)
          : null,
    }
  } catch {
    return { kv: null, waitUntil: null }
  }
}

async function fetchJson<T>(url: URL | string): Promise<T> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new UpstreamError(res.status, `CipherScan ${res.status} for ${String(url)}`)
  }
  return (await res.json()) as T
}

function flowUrl(pool: PoolMode, granularity: "hourly" | "daily"): URL {
  const url = new URL(`${CIPHERSCAN}/pools/flows`)
  url.searchParams.set("period", FLOW_PERIOD)
  url.searchParams.set("granularity", granularity)
  if (pool === "orchard") url.searchParams.set("pool", "orchard")
  return url
}

function recentFlowsUrl(pool: PoolMode): URL {
  const url = new URL(`${CIPHERSCAN}/shielded/list`)
  url.searchParams.set("flow_type", "all")
  url.searchParams.set("limit", String(RECENT_FLOW_LIMIT))
  if (pool === "orchard") url.searchParams.set("pool", "orchard")
  return url
}

function privacyStatsUrl(): URL {
  return new URL(`${CIPHERSCAN}/privacy-stats`)
}

async function fetchFlowSeries(
  pool: PoolMode,
  granularity: "hourly" | "daily"
): Promise<CipherscanFlowPoint[]> {
  const json = await fetchJson<CipherscanFlowsResponse>(flowUrl(pool, granularity))
  return Array.isArray(json.points) ? json.points : []
}

async function fetchRecentFlows(pool: PoolMode): Promise<CipherscanListResponse> {
  return fetchJson<CipherscanListResponse>(recentFlowsUrl(pool))
}

async function fetchPrivacyStats(): Promise<PrivacyStatsResponse | null> {
  try {
    return await fetchJson<PrivacyStatsResponse>(privacyStatsUrl())
  } catch {
    return null
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

async function fetchLiveZecPrice(kv: KVLike | null): Promise<number | null> {
  if (kv) {
    try {
      const cached = parsePositiveNumber(await kv.get(PRICE_KV_KEY))
      if (cached != null) return cached
    } catch {
      /* fall through */
    }
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
          try {
            await Promise.all([
              kv.put(PRICE_KV_KEY, String(price), {
                expirationTtl: PRICE_KV_TTL_SECONDS,
              }),
              kv.put(PRICE_KV_STALE_KEY, String(price)),
            ])
          } catch {}
        }
        return price
      }
    }
  } catch {
    /* fall through to last-known-good price */
  }

  if (kv) {
    try {
      return parsePositiveNumber(await kv.get(PRICE_KV_STALE_KEY))
    } catch {
      return null
    }
  }
  return null
}

function isoHour(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13) + ":00:00Z"
}

function emptyTotals(): ShieldingFlowTotals {
  return {
    inZec: 0,
    outZec: 0,
    netZec: 0,
    inUsd: 0,
    outUsd: 0,
    netUsd: 0,
    inTx: 0,
    outTx: 0,
  }
}

function addTotals(
  totals: ShieldingFlowTotals,
  values: Pick<ShieldingFlowTotals, "inZec" | "outZec" | "inTx" | "outTx">,
  priceUsd: number | null
) {
  totals.inZec += values.inZec
  totals.outZec += values.outZec
  totals.inTx += values.inTx
  totals.outTx += values.outTx
  totals.netZec = totals.inZec - totals.outZec
  totals.inUsd = priceUsd != null ? totals.inZec * priceUsd : 0
  totals.outUsd = priceUsd != null ? totals.outZec * priceUsd : 0
  totals.netUsd = totals.inUsd - totals.outUsd
}

function round(n: number, places = 8): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

function roundTotals(t: ShieldingFlowTotals): ShieldingFlowTotals {
  return {
    inZec: round(t.inZec),
    outZec: round(t.outZec),
    netZec: round(t.netZec),
    inUsd: round(t.inUsd, 2),
    outUsd: round(t.outUsd, 2),
    netUsd: round(t.netUsd, 2),
    inTx: t.inTx,
    outTx: t.outTx,
  }
}

function flowPointToBucket(
  point: CipherscanFlowPoint,
  granularity: "hourly" | "daily",
  priceUsd: number | null
): ShieldingBucket | null {
  const key = point.date
  if (!key) return null
  const inZec = typeof point.shield === "number" ? point.shield : 0
  const outZec = typeof point.deshield === "number" ? point.deshield : 0
  const inTx = typeof point.shieldTx === "number" ? point.shieldTx : 0
  const outTx = typeof point.deshieldTx === "number" ? point.deshieldTx : 0
  const normalizedKey =
    granularity === "hourly"
      ? new Date(Date.parse(key)).toISOString()
      : key.slice(0, 10)
  const totals = emptyTotals()
  addTotals(totals, { inZec, outZec, inTx, outTx }, priceUsd)
  return {
    key: normalizedKey,
    label: normalizedKey,
    ...roundTotals(totals),
  }
}

function filterBucketsSinceActivation(buckets: ShieldingBucket[]) {
  const activationHourMs = Date.parse(isoHour(Date.parse(ACTIVATION_TIME)))
  return buckets.filter((bucket) => Date.parse(bucket.key) >= activationHourMs)
}

function totalsForBuckets(
  buckets: ShieldingBucket[],
  cutoffMs: number | null,
  priceUsd: number | null
): ShieldingFlowTotals {
  const totals = emptyTotals()
  for (const bucket of buckets) {
    if (cutoffMs != null) {
      const ms = Date.parse(bucket.key)
      if (!Number.isFinite(ms) || ms < cutoffMs) continue
    }
    addTotals(totals, bucket, priceUsd)
  }
  return roundTotals(totals)
}

function repriceTotals<T extends ShieldingFlowTotals>(totals: T, priceUsd: number): T {
  return {
    ...totals,
    inUsd: round(totals.inZec * priceUsd, 2),
    outUsd: round(totals.outZec * priceUsd, 2),
    netUsd: round(totals.netZec * priceUsd, 2),
  }
}

function repriceTransfer(tx: ShieldingTransfer, priceUsd: number): ShieldingTransfer {
  return {
    ...tx,
    amountUsd: round(tx.amountZec * priceUsd, 2),
    recipients: tx.recipients.map((recipient) => ({
      ...recipient,
      valueUsd: round(recipient.valueZec * priceUsd, 2),
    })),
  }
}

function repricePayload(
  payload: ShieldingDetailsResponse,
  priceUsd: number | null
): ShieldingDetailsResponse {
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return payload
  }
  return {
    ...payload,
    network: {
      ...payload.network,
      priceUsd,
    },
    totals: {
      sinceActivation: repriceTotals(payload.totals.sinceActivation, priceUsd),
      lastHour: repriceTotals(payload.totals.lastHour, priceUsd),
      last24h: repriceTotals(payload.totals.last24h, priceUsd),
      last7d: repriceTotals(payload.totals.last7d, priceUsd),
    },
    series: {
      hourly: payload.series.hourly.map((bucket) => repriceTotals(bucket, priceUsd)),
      daily: payload.series.daily.map((bucket) => repriceTotals(bucket, priceUsd)),
    },
    blocks: {
      latest: payload.blocks.latest.map((block) => repriceTotals(block, priceUsd)),
      topOut: payload.blocks.topOut.map((block) => repriceTotals(block, priceUsd)),
      topNet: payload.blocks.topNet.map((block) => repriceTotals(block, priceUsd)),
    },
    recentOut: payload.recentOut.map((tx) => repriceTransfer(tx, priceUsd)),
    recentIn: payload.recentIn.map((tx) => repriceTransfer(tx, priceUsd)),
  }
}

function normalizeRecentFlow(
  flow: CipherscanFlow,
  priceUsd: number | null
): ShieldingTransfer | null {
  if (!flow.txid || typeof flow.blockHeight !== "number") return null
  if (flow.flowType !== "shield" && flow.flowType !== "deshield") return null
  const amountZec =
    typeof flow.amountZec === "number" && Number.isFinite(flow.amountZec)
      ? flow.amountZec
      : 0
  if (amountZec <= 0) return null
  const blockTime =
    typeof flow.blockTime === "number" && Number.isFinite(flow.blockTime)
      ? flow.blockTime * 1000
      : null
  if (blockTime == null) return null
  const addresses = Array.isArray(flow.addresses) ? flow.addresses : []
  const recipients: ShieldingTransferOutput[] =
    flow.flowType === "deshield"
      ? addresses.map((address) => ({
          recipient: address,
          valueZec: addresses.length === 1 ? round(amountZec) : 0,
          valueUsd:
            addresses.length === 1 && priceUsd != null
              ? round(amountZec * priceUsd, 2)
              : null,
        }))
      : []
  return {
    direction: flow.flowType === "shield" ? "in" : "out",
    hash: flow.txid,
    block: flow.blockHeight,
    time: new Date(blockTime).toISOString(),
    amountZec: round(amountZec),
    amountUsd: priceUsd != null ? round(amountZec * priceUsd, 2) : null,
    inputCount: null,
    outputCount: null,
    recipients,
    explorerUrl: `https://cipherscan.app/tx/${flow.txid}`,
  }
}

function buildBlocks(transfers: ShieldingTransfer[]): ShieldingBlockBucket[] {
  const map = new Map<number, ShieldingFlowTotals>()
  const times = new Map<number, string>()
  for (const tx of transfers) {
    const totals = map.get(tx.block) ?? emptyTotals()
    addTotals(
      totals,
      {
        inZec: tx.direction === "in" ? tx.amountZec : 0,
        outZec: tx.direction === "out" ? tx.amountZec : 0,
        inTx: tx.direction === "in" ? 1 : 0,
        outTx: tx.direction === "out" ? 1 : 0,
      },
      null
    )
    map.set(tx.block, totals)
    const prev = times.get(tx.block)
    if (!prev || tx.time > prev) times.set(tx.block, tx.time)
  }
  return [...map.entries()].map(([block, totals]) => ({
    block,
    time: times.get(block) ?? null,
    ...roundTotals(totals),
  }))
}

async function buildPayload(
  pool: PoolMode,
  livePriceUsd: number | null = null
): Promise<ShieldingDetailsResponse> {
  const [hourlyPoints, dailyPoints, recent, privacy] = await Promise.all([
    fetchFlowSeries(pool, "hourly"),
    fetchFlowSeries(pool, "daily"),
    fetchRecentFlows(pool).catch(
      () => ({ success: false, flows: [], pagination: {} }) as CipherscanListResponse
    ),
    fetchPrivacyStats(),
  ])

  const hourly = hourlyPoints
    .map((point) => flowPointToBucket(point, "hourly", livePriceUsd))
    .filter((bucket): bucket is ShieldingBucket => bucket != null)
    .sort((a, b) => a.key.localeCompare(b.key))
  const daily = dailyPoints
    .map((point) => flowPointToBucket(point, "daily", livePriceUsd))
    .filter((bucket): bucket is ShieldingBucket => bucket != null)
    .sort((a, b) => a.key.localeCompare(b.key))
  if (hourly.length === 0 && daily.length === 0) {
    throw new Error("CipherScan pools/flows returned no usable flow points")
  }
  const sinceActivationHourly = filterBucketsSinceActivation(hourly)

  const nowMs = Date.now()
  const hourMs = 60 * 60 * 1000
  const dayMs = 24 * hourMs
  const recentTransfers = (recent.flows ?? [])
    .map((flow) => normalizeRecentFlow(flow, livePriceUsd))
    .filter((tx): tx is ShieldingTransfer => tx != null)
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
  const recentOut = recentTransfers
    .filter((tx) => tx.direction === "out")
    .slice(0, RECENT_DETAIL_LIMIT)
  const recentIn = recentTransfers
    .filter((tx) => tx.direction === "in")
    .slice(0, RECENT_DETAIL_LIMIT)
  const blocks = buildBlocks(recentTransfers)
  const hourlyUrl = flowUrl(pool, "hourly")
  const dailyUrl = flowUrl(pool, "daily")
  const listUrl = recentFlowsUrl(pool)

  return {
    activation: {
      label: "NU6.2",
      block: ACTIVATION_BLOCK,
      time: ACTIVATION_TIME,
      outQuery: hourlyUrl.toString(),
      inQuery: dailyUrl.toString(),
    },
    network: {
      blockHeight:
        privacy?.lastBlockScanned ??
        privacy?.totals?.blocks ??
        recentTransfers[0]?.block ??
        null,
      bestBlockTime: recentTransfers[0]?.time ?? privacy?.lastUpdated ?? null,
      priceUsd: livePriceUsd,
      hashrate24h: null,
    },
    totals: {
      sinceActivation: totalsForBuckets(sinceActivationHourly, null, livePriceUsd),
      lastHour: totalsForBuckets(hourly, nowMs - hourMs, livePriceUsd),
      last24h: totalsForBuckets(hourly, nowMs - dayMs, livePriceUsd),
      last7d: totalsForBuckets(hourly, nowMs - 7 * dayMs, livePriceUsd),
    },
    series: {
      hourly,
      daily,
    },
    blocks: {
      latest: [...blocks].sort((a, b) => b.block - a.block).slice(0, 60),
      topOut: [...blocks].sort((a, b) => b.outZec - a.outZec).slice(0, 25),
      topNet: [...blocks]
        .sort((a, b) => Math.abs(b.netZec) - Math.abs(a.netZec))
        .slice(0, 25),
    },
    recentOut,
    recentIn,
    counts: {
      outFetched: recentOut.length,
      outTotalRows: recent.pagination?.total ?? null,
      inFetched: recentIn.length,
      inTotalRows: recent.pagination?.total ?? null,
      maxRows: RECENT_FLOW_LIMIT,
      truncated: false,
      rateLimited: false,
      errors: recent.success === false ? ["CipherScan recent flow list unavailable"] : [],
      recipientDetails: 0,
    },
    source: {
      stats: privacyStatsUrl().toString(),
      out: hourlyUrl.toString(),
      in: dailyUrl.toString(),
      details: listUrl.toString(),
    },
    notes: [
      pool === "orchard"
        ? "Pool mode is Orchard; CipherScan receives pool=orchard."
        : "Pool mode is all pools; CipherScan receives no pool parameter.",
      "IN is CipherScan shield flow; OUT is CipherScan deshield flow.",
      "Hourly and daily aggregate charts use CipherScan pools/flows; recent transaction rows use CipherScan shielded/list.",
    ],
    fetchedAt: Date.now(),
  }
}

function isShieldingDetailsResponse(
  payload: ShieldingDetailsResponse | null
): payload is ShieldingDetailsResponse {
  return payload?.totals?.sinceActivation != null
}

function parseCachedPayload(cached: string | null): ShieldingDetailsResponse | null {
  if (!cached) return null
  try {
    const parsed = JSON.parse(cached) as ShieldingDetailsResponse
    return isShieldingDetailsResponse(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeSnapshot(
  kv: KVLike,
  pool: PoolMode,
  payload: ShieldingDetailsResponse
) {
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(kvKey(pool), json, { expirationTtl: KV_TTL_SECONDS }),
    kv.put(staleKvKey(pool), json),
  ])
}

function refreshSnapshot(kv: KVLike, pool: PoolMode): Promise<void> {
  const existing = refreshInFlight.get(pool)
  if (existing) return existing
  const refresh = fetchLiveZecPrice(kv)
    .then((priceUsd) => buildPayload(pool, priceUsd))
    .then((payload) => writeSnapshot(kv, pool, payload))
    .catch(() => {
      /* keep serving the last stale mirror; foreground fallback handles cold misses */
    })
    .finally(() => {
      refreshInFlight.delete(pool)
    })
  refreshInFlight.set(pool, refresh)
  return refresh
}

export async function GET(request: Request) {
  const pool = parsePool(request)
  const { kv, waitUntil } = await getRuntimeBindings()
  const livePriceUsd = await fetchLiveZecPrice(kv)

  if (kv) {
    try {
      const parsed = parseCachedPayload(await kv.get(kvKey(pool)))
      if (parsed) {
        return NextResponse.json(repricePayload(parsed, livePriceUsd), {
          headers: RESPONSE_HEADERS,
        })
      }
      const stale = parseCachedPayload(await kv.get(staleKvKey(pool)))
      if (stale && waitUntil) {
        waitUntil(refreshSnapshot(kv, pool))
        return NextResponse.json(repricePayload(stale, livePriceUsd), {
          headers: RESPONSE_HEADERS,
        })
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const payload = await buildPayload(pool, livePriceUsd)
    if (kv) {
      try {
        await writeSnapshot(kv, pool, payload)
      } catch {}
    }
    return NextResponse.json(payload, {
      headers: RESPONSE_HEADERS,
    })
  } catch {
    if (kv) {
      try {
        const stale = parseCachedPayload(await kv.get(staleKvKey(pool)))
        if (stale) {
          const repriced = repricePayload(stale, livePriceUsd)
          return NextResponse.json(
            { ...repriced, stale: true },
            { headers: RESPONSE_HEADERS }
          )
        }
      } catch {
        /* fall through */
      }
    }
  }

  return NextResponse.json(
    { error: "ZEC shielding-details upstream unavailable" },
    { status: 502 }
  )
}
