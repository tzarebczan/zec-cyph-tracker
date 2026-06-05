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

const BLOCKCHAIR = "https://api.blockchair.com/zcash"
const ACTIVATION_BLOCK = 3_364_600
const ACTIVATION_TIME = "2026-06-03T04:03:08Z"

const PAGE_LIMIT = 100
const MAX_ROWS = 2_000
const RECENT_DETAIL_LIMIT = 40
const KV_KEY = "zec.shielding-details.v1"
const KV_STALE_KEY = "zec.shielding-details.stale.v1"
const KV_TTL_SECONDS = 60

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-shielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

function blockRangeQuery(upperBlock: number | null): string {
  return upperBlock != null && Number.isFinite(upperBlock)
    ? `block_id(${ACTIVATION_BLOCK}..${upperBlock})`
    : `block_id(${ACTIVATION_BLOCK}..)`
}

function outQuery(upperBlock: number | null): string {
  return `${blockRangeQuery(upperBlock)},input_count(0),is_coinbase(false),output_total(1..)`
}

function inQuery(upperBlock: number | null): string {
  return `${blockRangeQuery(upperBlock)},shielded_value_delta(1..),is_coinbase(false)`
}

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

interface BlockchairContext {
  total_rows?: number
  state?: number
  market_price_usd?: number
}

interface BlockchairListResponse {
  data?: RawTx[]
  context?: BlockchairContext
}

interface BlockchairStatsResponse {
  data?: {
    blocks?: number
    best_block_height?: number
    best_block_time?: string
    market_price_usd?: number
    price_usd?: number
    hashrate_24h?: number | string
  }
}

interface RawTx {
  block_id?: number
  hash?: string
  date?: string
  time?: string
  input_count?: number | null
  output_count?: number | null
  input_total?: number | null
  input_total_usd?: number | null
  output_total?: number | null
  output_total_usd?: number | null
  fee?: number | null
  fee_usd?: number | null
  shielded_value_delta?: number | null
}

interface BlockchairDetailsResponse {
  data?: Record<
    string,
    {
      outputs?: RawOutput[]
    }
  >
}

interface RawOutput {
  recipient?: string | null
  value?: number | null
  value_usd?: number | null
}

interface PageResult {
  rows: RawTx[]
  totalRows: number | null
  chainHeight: number | null
  marketPriceUsd: number | null
  truncated: boolean
  rateLimited: boolean
  error: string | null
}

class UpstreamError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getKV(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    return (
      (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
    )
  } catch {
    return null
  }
}

async function fetchJson<T>(url: URL | string): Promise<T> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new UpstreamError(res.status, `Blockchair ${res.status} for ${String(url)}`)
  }
  return (await res.json()) as T
}

function txListUrl(query: string, offset: number, limit: number): URL {
  const url = new URL(`${BLOCKCHAIR}/transactions`)
  url.searchParams.set("q", query)
  url.searchParams.set("limit", String(limit))
  url.searchParams.set("offset", String(offset))
  url.searchParams.set("s", "time(desc)")
  return url
}

async function fetchTxPages(query: string): Promise<PageResult> {
  const rows: RawTx[] = []
  let totalRows: number | null = null
  let chainHeight: number | null = null
  let marketPriceUsd: number | null = null

  let error: string | null = null
  let rateLimited = false
  let offset = 0

  while (offset < MAX_ROWS) {
    if (totalRows != null && offset >= totalRows) break
    const limit =
      totalRows != null
        ? Math.max(1, Math.min(PAGE_LIMIT, totalRows - offset, MAX_ROWS - offset))
        : Math.min(PAGE_LIMIT, MAX_ROWS - offset)
    let json: BlockchairListResponse
    try {
      json = await fetchJson<BlockchairListResponse>(txListUrl(query, offset, limit))
    } catch (e) {
      error = e instanceof Error ? e.message : "Blockchair page fetch failed"
      rateLimited = e instanceof UpstreamError && e.status === 402
      break
    }
    const page = Array.isArray(json.data) ? json.data : []
    if (typeof json.context?.total_rows === "number") {
      totalRows = json.context.total_rows
    }
    if (typeof json.context?.state === "number") {
      chainHeight = json.context.state
    }
    if (typeof json.context?.market_price_usd === "number") {
      marketPriceUsd = json.context.market_price_usd
    }
    rows.push(...page)
    if (page.length === 0) break
    offset += page.length
    if (totalRows != null && rows.length >= totalRows) break
  }

  return {
    rows,
    totalRows,
    chainHeight,
    marketPriceUsd,
    truncated:
      error != null ||
      (totalRows != null ? rows.length < totalRows : rows.length >= MAX_ROWS),
    rateLimited,
    error,
  }
}

function zatsToZec(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value / 1e8 : 0
}

function usdFrom(rowUsd: number | null | undefined, zec: number, price: number | null) {
  if (typeof rowUsd === "number" && Number.isFinite(rowUsd) && rowUsd > 0) {
    return rowUsd
  }
  return price != null && Number.isFinite(price) ? zec * price : null
}

function parseBlockchairTime(time: string | null | undefined): number | null {
  if (!time) return null
  const iso = time.includes("T") ? time : `${time.replace(" ", "T")}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function isoHour(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13) + ":00:00Z"
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
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

function addTransfer(
  totals: ShieldingFlowTotals,
  tx: Pick<ShieldingTransfer, "direction" | "amountZec" | "amountUsd">
) {
  if (tx.direction === "in") {
    totals.inZec += tx.amountZec
    totals.inUsd += tx.amountUsd ?? 0
    totals.inTx += 1
  } else {
    totals.outZec += tx.amountZec
    totals.outUsd += tx.amountUsd ?? 0
    totals.outTx += 1
  }
  totals.netZec = totals.inZec - totals.outZec
  totals.netUsd = totals.inUsd - totals.outUsd
}

function roundTotals(t: ShieldingFlowTotals): ShieldingFlowTotals {
  return {
    inZec: round(t.inZec),
    outZec: round(t.outZec),
    netZec: round(t.netZec),
    inUsd: round(t.inUsd),
    outUsd: round(t.outUsd),
    netUsd: round(t.netUsd),
    inTx: t.inTx,
    outTx: t.outTx,
  }
}

function round(n: number, places = 8): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

function normalizeOut(row: RawTx, priceUsd: number | null): ShieldingTransfer | null {
  if (!row.hash || typeof row.block_id !== "number") return null
  const amountZec = zatsToZec(row.output_total)
  if (amountZec <= 0) return null
  const timeMs = parseBlockchairTime(row.time)
  if (timeMs == null) return null
  return {
    direction: "out",
    hash: row.hash,
    block: row.block_id,
    time: new Date(timeMs).toISOString(),
    amountZec: round(amountZec),
    amountUsd: usdFrom(row.output_total_usd, amountZec, priceUsd),
    inputCount: row.input_count ?? null,
    outputCount: row.output_count ?? null,
    recipients: [],
    blockchairUrl: `https://blockchair.com/zcash/transaction/${row.hash}`,
  }
}

function normalizeIn(row: RawTx, priceUsd: number | null): ShieldingTransfer | null {
  if (!row.hash || typeof row.block_id !== "number") return null
  const amountZec = zatsToZec(row.shielded_value_delta)
  if (amountZec <= 0) return null
  const timeMs = parseBlockchairTime(row.time)
  if (timeMs == null) return null
  return {
    direction: "in",
    hash: row.hash,
    block: row.block_id,
    time: new Date(timeMs).toISOString(),
    amountZec: round(amountZec),
    amountUsd: usdFrom(row.input_total_usd, amountZec, priceUsd),
    inputCount: row.input_count ?? null,
    outputCount: row.output_count ?? null,
    recipients: [],
    blockchairUrl: `https://blockchair.com/zcash/transaction/${row.hash}`,
  }
}

async function fetchOutputDetails(hashes: string[]): Promise<Record<string, ShieldingTransferOutput[]>> {
  const out: Record<string, ShieldingTransferOutput[]> = {}
  for (let i = 0; i < hashes.length; i += 10) {
    const batch = hashes.slice(i, i + 10)
    const url = `${BLOCKCHAIR}/dashboards/transactions/${batch.join(",")}`
    const json = await fetchJson<BlockchairDetailsResponse>(url)
    for (const hash of batch) {
      const outputs = json.data?.[hash]?.outputs ?? []
      out[hash] = outputs
        .filter((o) => typeof o.value === "number" && (o.value ?? 0) > 0)
        .map((o) => ({
          recipient: o.recipient ?? null,
          valueZec: round(zatsToZec(o.value)),
          valueUsd:
            typeof o.value_usd === "number" && Number.isFinite(o.value_usd)
              ? o.value_usd
              : null,
        }))
    }
  }
  return out
}

function buildSeries(transfers: ShieldingTransfer[], kind: "hour" | "day"): ShieldingBucket[] {
  const map = new Map<string, ShieldingFlowTotals>()
  for (const tx of transfers) {
    const ms = Date.parse(tx.time)
    if (!Number.isFinite(ms)) continue
    const key = kind === "hour" ? isoHour(ms) : isoDay(ms)
    const totals = map.get(key) ?? emptyTotals()
    addTransfer(totals, tx)
    map.set(key, totals)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, totals]) => ({
      key,
      label: key,
      ...roundTotals(totals),
    }))
}

function buildBlocks(transfers: ShieldingTransfer[]): ShieldingBlockBucket[] {
  const map = new Map<number, ShieldingFlowTotals>()
  const times = new Map<number, string>()
  for (const tx of transfers) {
    const totals = map.get(tx.block) ?? emptyTotals()
    addTransfer(totals, tx)
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

function totalsFor(transfers: ShieldingTransfer[], cutoffMs: number | null): ShieldingFlowTotals {
  const totals = emptyTotals()
  for (const tx of transfers) {
    if (cutoffMs != null) {
      const ms = Date.parse(tx.time)
      if (!Number.isFinite(ms) || ms < cutoffMs) continue
    }
    addTransfer(totals, tx)
  }
  return roundTotals(totals)
}

async function buildPayload(): Promise<ShieldingDetailsResponse> {
  const stats = await fetchJson<BlockchairStatsResponse>(`${BLOCKCHAIR}/stats`).catch(
    () => ({ data: {} }) as BlockchairStatsResponse
  )
  const upperBlock =
    stats.data?.best_block_height ?? stats.data?.blocks ?? null
  const actualOutQuery = outQuery(upperBlock)
  const actualInQuery = inQuery(upperBlock)
  const [outPages, inPages] = await Promise.all([
    fetchTxPages(actualOutQuery),
    fetchTxPages(actualInQuery),
  ])

  const priceUsd =
    stats.data?.market_price_usd ??
    stats.data?.price_usd ??
    outPages.marketPriceUsd ??
    inPages.marketPriceUsd ??
    null

  const recentOut = outPages.rows
    .map((row) => normalizeOut(row, priceUsd))
    .filter((row): row is ShieldingTransfer => row != null)

  const recentIn = inPages.rows
    .map((row) => normalizeIn(row, priceUsd))
    .filter((row): row is ShieldingTransfer => row != null)

  const detailHashes = recentOut.slice(0, RECENT_DETAIL_LIMIT).map((tx) => tx.hash)
  try {
    const details = await fetchOutputDetails(detailHashes)
    for (const tx of recentOut) {
      tx.recipients = details[tx.hash] ?? []
    }
  } catch {
    // Recipient enrichment is useful, not required. Keep the aggregate monitor alive.
  }

  const transfers = [...recentOut, ...recentIn].sort((a, b) =>
    a.time < b.time ? 1 : a.time > b.time ? -1 : 0
  )

  const chainNowMs =
    parseBlockchairTime(stats.data?.best_block_time) ??
    (transfers.length > 0 ? Date.parse(transfers[0].time) : Date.now())
  const hourMs = 60 * 60 * 1000
  const dayMs = 24 * hourMs
  const blocks = buildBlocks(transfers)

  return {
    activation: {
      label: "NU6.2",
      block: ACTIVATION_BLOCK,
      time: ACTIVATION_TIME,
      outQuery: actualOutQuery,
      inQuery: actualInQuery,
    },
    network: {
      blockHeight:
        stats.data?.best_block_height ??
        stats.data?.blocks ??
        outPages.chainHeight ??
        inPages.chainHeight ??
        null,
      bestBlockTime: stats.data?.best_block_time
        ? new Date(parseBlockchairTime(stats.data.best_block_time) ?? Date.now()).toISOString()
        : null,
      priceUsd,
      hashrate24h:
        typeof stats.data?.hashrate_24h === "string"
          ? Number(stats.data.hashrate_24h)
          : stats.data?.hashrate_24h ?? null,
    },
    totals: {
      sinceActivation: totalsFor(transfers, null),
      lastHour: totalsFor(transfers, chainNowMs - hourMs),
      last24h: totalsFor(transfers, chainNowMs - dayMs),
      last7d: totalsFor(transfers, chainNowMs - 7 * dayMs),
    },
    series: {
      hourly: buildSeries(transfers, "hour"),
      daily: buildSeries(transfers, "day"),
    },
    blocks: {
      latest: [...blocks].sort((a, b) => b.block - a.block).slice(0, 60),
      topOut: [...blocks].sort((a, b) => b.outZec - a.outZec).slice(0, 25),
      topNet: [...blocks]
        .sort((a, b) => Math.abs(b.netZec) - Math.abs(a.netZec))
        .slice(0, 25),
    },
    recentOut: recentOut.slice(0, RECENT_DETAIL_LIMIT),
    recentIn: recentIn.slice(0, RECENT_DETAIL_LIMIT),
    counts: {
      outFetched: recentOut.length,
      outTotalRows: outPages.totalRows,
      inFetched: recentIn.length,
      inTotalRows: inPages.totalRows,
      maxRows: MAX_ROWS,
      truncated: outPages.truncated || inPages.truncated,
      rateLimited: outPages.rateLimited || inPages.rateLimited,
      errors: [outPages.error, inPages.error].filter((e): e is string => e != null),
      recipientDetails: detailHashes.length,
    },
    source: {
      stats: "https://api.blockchair.com/zcash/stats",
      out: `${BLOCKCHAIR}/transactions?q=${encodeURIComponent(actualOutQuery)}&limit=${PAGE_LIMIT}&s=time(desc)`,
      in: `${BLOCKCHAIR}/transactions?q=${encodeURIComponent(actualInQuery)}&limit=${PAGE_LIMIT}&s=time(desc)`,
      details: `${BLOCKCHAIR}/dashboards/transactions/{hashes}`,
    },
    notes: [
      "OUT requires zero transparent inputs, non-coinbase, and positive transparent output_total.",
      "IN uses positive shielded_value_delta, which captures transparent value entering shielded outputs.",
      "Shielded recipients are hidden by the protocol; transparent exit recipients are enriched for recent OUT rows.",
    ],
    fetchedAt: Date.now(),
  }
}

export async function GET() {
  const kv = await getKV()

  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as ShieldingDetailsResponse
        if (parsed?.totals?.sinceActivation) {
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=30" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const payload = await buildPayload()
    if (kv) {
      const json = JSON.stringify(payload)
      try {
        await Promise.all([
          kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
          kv.put(KV_STALE_KEY, json),
        ])
      } catch {}
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=30" },
    })
  } catch {
    if (kv) {
      try {
        const stale = await kv.get(KV_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as ShieldingDetailsResponse
          if (parsed?.totals?.sinceActivation) {
            return NextResponse.json(
              { ...parsed, stale: true },
              { headers: { "Cache-Control": "public, max-age=30" } }
            )
          }
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
