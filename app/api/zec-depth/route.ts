import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Aggregated ZEC order-book depth + trade tape + intraday microstructure.
//
// Powers three surfaces:
//   • the dashboard ZEC tile's toggle-able DEPTH strip
//   • the dashboard's full-width ORDER BOOK DEPTH section
//   • /stats -> ZEC -> DEPTH & FLOW
//
// ---------------------------------------------------------------------------
// Why aggregate, and how the books are stitched together
// ---------------------------------------------------------------------------
// No single venue holds a meaningful share of ZEC liquidity, so a single-venue
// depth chart is misleading. We pull the full L2 book from six venues and
// combine them into one book.
//
// Venues quote in different units (USD on Kraken/Coinbase, USDT elsewhere) and
// trade at a small basis to each other. Bucketing raw prices would smear the
// book: a venue trading 30 bps rich would drop its asks *below* the consensus
// mid and manufacture crossed liquidity that nobody can actually trade. So we
// mid-align instead — every venue's prices are scaled by
// `consensusMid / venueMid` before bucketing, which is the standard way to
// build an aggregated depth curve. The raw deviation each venue was scaled by
// is reported back per-venue as `basisBps` so nothing is hidden.
//
// The consensus mid itself is a depth-weighted average of the USD-quoted
// venues (Kraken, Coinbase) when either is up, so the headline mid is a real
// USD number rather than a USDT one. USDT venues only set the mid if both USD
// venues fail.
//
// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
// Two independent caches, because the two halves of the payload move at very
// different speeds:
//   • book + tape: 5 s per-instance memory cache. The client polls every ~6 s,
//     so this collapses every concurrent viewer on an instance into one
//     upstream fan-out and bounds us to ~1 fan-out / 5 s / instance.
//   • intraday candles (`micro`): 60 s memory cache. 5-minute candles simply
//     do not change faster than that, and it keeps our sustained Kraken call
//     rate down to Depth + Trades rather than Depth + Trades + 2x OHLC.
// A KV mirror (no TTL, written at most every 30 s) is the cold-start / total
// upstream failure fallback, matching the pattern in /api/prices and friends.

// Live feed: never let the framework try to prerender or cache this at build
// time. (The no-store upstream fetches already force dynamic rendering; this
// states the intent so a future refactor can't quietly make it static.)
export const dynamic = "force-dynamic"

const BIN_BPS = 5
/** Chart / ladder / wall horizon. Two percent either side of the mid is where
 *  essentially all actionable ZEC liquidity sits. */
const MAX_BPS = 200
const BIN_COUNT = MAX_BPS / BIN_BPS
/** How deep the market-impact walk is allowed to reach. Deliberately much
 *  wider than the chart: a $5M order eats straight through ±2%, and answering
 *  "n/a" when the books plainly hold the size would be the wrong answer. Also
 *  bounded, because a couple of venues carry junk levels out at 100x mid. */
const IMPACT_MAX_BPS = 1_000
/** Distances (bps from mid) reported in the depth ladder table. */
const LADDER_BPS = [10, 25, 50, 100, 200] as const
/** Notional sizes walked through the book for the market-impact table. */
const IMPACT_USD = [50_000, 250_000, 1_000_000, 5_000_000] as const
/** Tape aggregation windows, in minutes. */
const TAPE_WINDOWS = [1, 5, 15] as const
/** A trade has to clear this to show up in the large-print feed. */
const PRINT_MIN_USD = 10_000
/** How far back the large-print feed looks. */
const PRINT_WINDOW_MS = 10 * 60_000
const PRINT_LIMIT = 12
/** CVD sparkline geometry — 15 minutes of 30-second buckets. */
const CVD_BUCKET_MS = 30_000
const CVD_BUCKETS = 30

const FRESH_TTL_MS = 5_000
const MICRO_FRESH_TTL_MS = 60_000
const STALE_TTL_MS = 10 * 60_000
const KV_KEY = "zec.depth.stale.v1"
const KV_WRITE_MIN_SPACING_MS = 30_000
const RESPONSE_HEADERS = {
  // Deliberately short: this endpoint exists to look live. `s-maxage` still
  // shields the origin from a refresh storm without visibly freezing the
  // depth chart.
  "Cache-Control": "public, max-age=0, s-maxage=5, stale-while-revalidate=20",
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
const HEADERS = { "User-Agent": UA, Accept: "application/json" }

// ---------- Wire types (mirrored in components/api-types.ts) ----------------

interface DepthBin {
  /** Outer edge of the bin, in bps from the consensus mid. */
  bps: number
  bidUsd: number
  askUsd: number
  bidCumUsd: number
  askCumUsd: number
}

interface DepthLadderRow {
  bps: number
  bidUsd: number
  askUsd: number
  bidZec: number
  askZec: number
  /** (bid - ask) / (bid + ask) inside this distance. Positive = bid-heavy. */
  imbalance: number | null
}

interface DepthWall {
  side: "bid" | "ask"
  price: number
  usd: number
  zec: number
  bps: number
  venues: number
}

interface DepthImpactRow {
  usd: number
  buyBps: number | null
  sellBps: number | null
  buyPrice: number | null
  sellPrice: number | null
}

interface DepthVenue {
  id: string
  name: string
  pair: string
  ok: boolean
  error: string | null
  mid: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number | null
  bidUsd: number
  askUsd: number
  depthUsd: number
  /** Share of the aggregate ±1% depth this venue contributed. */
  share: number
  /** Venue mid vs consensus mid, in bps. Signed; positive = trading rich. */
  basisBps: number | null
  levels: number
}

interface TapeWindow {
  minutes: number
  buyUsd: number
  sellUsd: number
  deltaUsd: number
  /** buyUsd / (buyUsd + sellUsd). Null when the window saw no volume. */
  pressure: number | null
  trades: number
  /** Venue names actually summed for this window. */
  venues: string[]
  /** How many live tape venues had trade history reaching back the whole
   *  window. Compare against `venuesLive`: fewer means the totals
   *  under-state real flow, and zero means not even the venues that were
   *  summed had the full window. */
  covered: number
  /** Live tape venues in this snapshot, whether or not they covered. */
  venuesLive: number
}

interface TapePrint {
  id: string
  ts: number
  side: "buy" | "sell"
  usd: number
  price: number
  zec: number
  venue: string
}

interface CvdPoint {
  ts: number
  cum: number
}

interface MicroStats {
  price: number | null
  high24h: number | null
  low24h: number | null
  /** 24h range as a % of the low. */
  rangePct24h: number | null
  vwap24h: number | null
  vwapPremiumBps: number | null
  /** Annualized realized volatility, %, from 5-minute log returns. */
  vol24hPct: number | null
  /** Annualized realized volatility, %, from hourly log returns. */
  vol7dPct: number | null
  vol30dPct: number | null
  /** Average true range over the last 24h, as a % of price. */
  atr24hPct: number | null
  volumeZec24h: number | null
  high7d: number | null
  low7d: number | null
  high30d: number | null
  low30d: number | null
  /** % change over each lookback. */
  trend: {
    m5: number | null
    m15: number | null
    h1: number | null
    h4: number | null
    h24: number | null
  }
  /** 5-minute closes covering the last 24h, oldest first. Sent as a
   *  packed series (start + step + values) rather than 288 `{ts, close}`
   *  objects — this endpoint is polled every few seconds, so the ~7 KB
   *  the object form costs per response is worth avoiding. */
  candles: {
    startTs: number
    endTs: number
    stepMs: number
    closes: number[]
  } | null
}

interface ZecDepthResponse {
  mid: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number | null
  bins: DepthBin[]
  ladder: DepthLadderRow[]
  imbalance1pct: number | null
  walls: DepthWall[]
  impact: DepthImpactRow[]
  venues: DepthVenue[]
  tape: {
    windows: TapeWindow[]
    prints: TapePrint[]
    cvd: CvdPoint[]
    minPrintUsd: number
    printWindowMinutes: number
  }
  micro: MicroStats | null
  totals: { bidUsd: number; askUsd: number }
  maxBps: number
  /** How far out the market-impact walk was allowed to fill, in bps. */
  impactMaxBps: number
  venuesOk: number
  venuesTotal: number
  fetchedAt: number
  stale?: boolean
}

// ---------- Upstream plumbing ----------------------------------------------

type Level = [price: number, size: number]
interface RawBook {
  bids: Level[]
  asks: Level[]
}
interface RawTrade {
  id: string
  ts: number
  side: "buy" | "sell"
  price: number
  size: number
}

interface VenueDef {
  id: string
  name: string
  pair: string
  bookUrl: string
  parseBook: (json: unknown) => RawBook
  tradesUrl?: string
  parseTrades?: (json: unknown) => RawTrade[]
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** Coerce a `[price, size, ...]` tuple array into clean Level pairs. */
function levels(raw: unknown): Level[] {
  if (!Array.isArray(raw)) return []
  const out: Level[] = []
  for (const row of raw) {
    if (!Array.isArray(row)) continue
    const px = num(row[0])
    const sz = num(row[1])
    if (!(px > 0) || !(sz > 0)) continue
    out.push([px, sz])
  }
  return out
}

/** Kraken nests its payload under a pair key we don't want to hardcode
 *  (`ZECUSD` resolves to `XZECZUSD`), so return the first non-`last` key's
 *  value. Shared by the Depth, Trades and OHLC parsers. */
function krakenPayload(json: unknown): unknown {
  const result = (json as { result?: Record<string, unknown> } | null)?.result
  if (!result || typeof result !== "object") return null
  for (const key of Object.keys(result)) {
    if (key !== "last") return result[key]
  }
  return null
}

const VENUES: VenueDef[] = [
  {
    id: "kraken",
    name: "Kraken",
    pair: "ZEC/USD",
    bookUrl: "https://api.kraken.com/0/public/Depth?pair=ZECUSD&count=500",
    parseBook: (json) => {
      const book = krakenPayload(json) as
        | { bids?: unknown; asks?: unknown }
        | null
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
    tradesUrl: "https://api.kraken.com/0/public/Trades?pair=ZECUSD&count=1000",
    parseTrades: (json) => {
      const rows = krakenPayload(json)
      if (!Array.isArray(rows)) return []
      const out: RawTrade[] = []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        const price = num(row[0])
        const size = num(row[1])
        const ts = num(row[2])
        // Kraken's flag is the AGGRESSOR side, which is what we want.
        const side = row[3] === "s" ? "sell" : "buy"
        if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
        out.push({
          id: `kraken:${row[6] ?? `${ts}-${price}-${size}`}`,
          ts: Math.round(ts * 1000),
          side,
          price,
          size,
        })
      }
      return out
    },
  },
  {
    id: "coinbase",
    name: "Coinbase",
    pair: "ZEC/USD",
    bookUrl: "https://api.exchange.coinbase.com/products/ZEC-USD/book?level=2",
    parseBook: (json) => {
      const book = json as { bids?: unknown; asks?: unknown } | null
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
    tradesUrl:
      "https://api.exchange.coinbase.com/products/ZEC-USD/trades?limit=1000",
    parseTrades: (json) => {
      if (!Array.isArray(json)) return []
      const out: RawTrade[] = []
      for (const row of json) {
        const t = row as {
          trade_id?: number
          side?: string
          size?: string
          price?: string
          time?: string
        }
        const price = num(t.price)
        const size = num(t.size)
        const ts = Date.parse(t.time ?? "")
        if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
        // Coinbase Exchange reports the MAKER side on this feed, the
        // opposite convention to Kraken/OKX. Invert so every venue in the
        // tape means the same thing by "buy" (an aggressive taker buy).
        const side = t.side === "buy" ? "sell" : "buy"
        out.push({
          id: `coinbase:${t.trade_id ?? `${ts}-${price}`}`,
          ts,
          side,
          price,
          size,
        })
      }
      return out
    },
  },
  {
    id: "okx",
    name: "OKX",
    pair: "ZEC/USDT",
    bookUrl: "https://www.okx.com/api/v5/market/books?instId=ZEC-USDT&sz=400",
    parseBook: (json) => {
      const book = (json as { data?: unknown[] } | null)?.data?.[0] as
        | { bids?: unknown; asks?: unknown }
        | undefined
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
    tradesUrl:
      "https://www.okx.com/api/v5/market/trades?instId=ZEC-USDT&limit=500",
    parseTrades: (json) => {
      const rows = (json as { data?: unknown[] } | null)?.data
      if (!Array.isArray(rows)) return []
      const out: RawTrade[] = []
      for (const row of rows) {
        const t = row as {
          tradeId?: string
          side?: string
          sz?: string
          px?: string
          ts?: string
        }
        const price = num(t.px)
        const size = num(t.sz)
        const ts = num(t.ts)
        if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
        out.push({
          id: `okx:${t.tradeId ?? `${ts}-${price}`}`,
          ts,
          side: t.side === "sell" ? "sell" : "buy",
          price,
          size,
        })
      }
      return out
    },
  },
  {
    id: "gate",
    name: "Gate.io",
    pair: "ZEC/USDT",
    bookUrl:
      "https://api.gateio.ws/api/v4/spot/order_book?currency_pair=ZEC_USDT&limit=1000",
    parseBook: (json) => {
      const book = json as { bids?: unknown; asks?: unknown } | null
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
  },
  {
    id: "mexc",
    name: "MEXC",
    pair: "ZEC/USDT",
    bookUrl: "https://api.mexc.com/api/v3/depth?symbol=ZECUSDT&limit=1000",
    parseBook: (json) => {
      const book = json as { bids?: unknown; asks?: unknown } | null
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
  },
  {
    // Best-effort. Binance geo-blocks a chunk of cloud egress with a 451,
    // in which case this venue simply reports `ok: false` and the aggregate
    // carries on with the rest. It's the single largest ZEC book when it is
    // reachable, so it's worth the one failed request.
    id: "binance",
    name: "Binance",
    pair: "ZEC/USDT",
    bookUrl: "https://api.binance.com/api/v3/depth?symbol=ZECUSDT&limit=1000",
    parseBook: (json) => {
      const book = json as { bids?: unknown; asks?: unknown } | null
      return { bids: levels(book?.bids), asks: levels(book?.asks) }
    },
  },
]

async function fetchJson(url: string, timeoutMs = 7_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------- Aggregation ----------------------------------------------------

interface VenueBook {
  def: VenueDef
  bids: Level[]
  asks: Level[]
  bestBid: number
  bestAsk: number
  mid: number
  /** Notional resting within ±1% of this venue's own mid, in quote units. */
  bidUsd: number
  askUsd: number
}

function sideNotional(levelsIn: Level[], mid: number, bps: number): number {
  const limit = (mid * bps) / 10_000
  let total = 0
  for (const [px, sz] of levelsIn) {
    if (Math.abs(px - mid) > limit) continue
    total += px * sz
  }
  return total
}

function buildVenueBook(def: VenueDef, raw: RawBook): VenueBook | null {
  const bids = [...raw.bids].sort((a, b) => b[0] - a[0])
  const asks = [...raw.asks].sort((a, b) => a[0] - b[0])
  const bestBid = bids[0]?.[0] ?? NaN
  const bestAsk = asks[0]?.[0] ?? NaN
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return null
  const mid = (bestBid + bestAsk) / 2
  return {
    def,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    bidUsd: sideNotional(bids, mid, 100),
    askUsd: sideNotional(asks, mid, 100),
  }
}

/** Depth-weighted mean of a venue set's mids. Falls back to a plain mean
 *  when nobody reported any ±1% depth (thin book / parse oddity). */
function consensus(books: VenueBook[]): number | null {
  if (books.length === 0) return null
  let wsum = 0
  let vsum = 0
  for (const b of books) {
    const w = b.bidUsd + b.askUsd
    if (w > 0) {
      wsum += w
      vsum += b.mid * w
    }
  }
  if (wsum > 0) return vsum / wsum
  return books.reduce((s, b) => s + b.mid, 0) / books.length
}

/** Round to a "nice" 1 / 2 / 5 x 10^n step so wall prices land on
 *  human-readable increments instead of $0.7813. */
function niceStep(target: number): number {
  if (!(target > 0)) return 1
  const exp = Math.floor(Math.log10(target))
  const base = Math.pow(10, exp)
  const frac = target / base
  const mult = frac <= 1.5 ? 1 : frac <= 3.5 ? 2 : frac <= 7.5 ? 5 : 10
  return mult * base
}

function round(n: number, dp = 0): number {
  const f = Math.pow(10, dp)
  return Math.round(n * f) / f
}

interface AlignedLevel {
  /** Mid-aligned price. */
  px: number
  zec: number
  usd: number
  bps: number
  venue: string
}

function aggregateBooks(books: VenueBook[], mid: number) {
  const bidLevels: AlignedLevel[] = []
  const askLevels: AlignedLevel[] = []
  for (const b of books) {
    // Mid-align: fold each venue's basis (and any USDT peg drift) out of
    // its prices so all six books share one centre. See the file header.
    const scale = mid / b.mid
    for (const [px, sz] of b.bids) {
      const aligned = px * scale
      const bps = ((mid - aligned) / mid) * 10_000
      if (bps < 0 || bps > IMPACT_MAX_BPS) continue
      bidLevels.push({
        px: aligned,
        zec: sz,
        usd: aligned * sz,
        bps,
        venue: b.def.id,
      })
    }
    for (const [px, sz] of b.asks) {
      const aligned = px * scale
      const bps = ((aligned - mid) / mid) * 10_000
      if (bps < 0 || bps > IMPACT_MAX_BPS) continue
      askLevels.push({
        px: aligned,
        zec: sz,
        usd: aligned * sz,
        bps,
        venue: b.def.id,
      })
    }
  }
  bidLevels.sort((a, b) => b.px - a.px)
  askLevels.sort((a, b) => a.px - b.px)
  return { bidLevels, askLevels }
}

function buildBins(
  bidLevels: AlignedLevel[],
  askLevels: AlignedLevel[]
): DepthBin[] {
  const bid = new Array<number>(BIN_COUNT).fill(0)
  const ask = new Array<number>(BIN_COUNT).fill(0)
  const push = (src: AlignedLevel[], usd: number[]) => {
    for (const lv of src) {
      if (lv.bps > MAX_BPS) continue
      const idx = Math.min(BIN_COUNT - 1, Math.floor(lv.bps / BIN_BPS))
      usd[idx] += lv.usd
    }
  }
  push(bidLevels, bid)
  push(askLevels, ask)

  const bins: DepthBin[] = []
  let bidCum = 0
  let askCum = 0
  for (let i = 0; i < BIN_COUNT; i++) {
    bidCum += bid[i]
    askCum += ask[i]
    bins.push({
      bps: (i + 1) * BIN_BPS,
      bidUsd: round(bid[i]),
      askUsd: round(ask[i]),
      bidCumUsd: round(bidCum),
      askCumUsd: round(askCum),
    })
  }
  return bins
}

function buildLadder(
  bidLevels: AlignedLevel[],
  askLevels: AlignedLevel[]
): DepthLadderRow[] {
  return LADDER_BPS.map((bps) => {
    let bidUsd = 0
    let askUsd = 0
    let bidZec = 0
    let askZec = 0
    for (const lv of bidLevels) {
      if (lv.bps > bps) break
      bidUsd += lv.usd
      bidZec += lv.zec
    }
    for (const lv of askLevels) {
      if (lv.bps > bps) break
      askUsd += lv.usd
      askZec += lv.zec
    }
    const total = bidUsd + askUsd
    return {
      bps,
      bidUsd: round(bidUsd),
      askUsd: round(askUsd),
      bidZec: round(bidZec, 2),
      askZec: round(askZec, 2),
      imbalance: total > 0 ? round((bidUsd - askUsd) / total, 4) : null,
    }
  })
}

function buildWalls(
  bidLevels: AlignedLevel[],
  askLevels: AlignedLevel[],
  mid: number
): DepthWall[] {
  const step = niceStep(mid * 0.001)
  const collect = (src: AlignedLevel[], side: "bid" | "ask"): DepthWall[] => {
    const buckets = new Map<
      number,
      { usd: number; zec: number; venues: Set<string> }
    >()
    for (const lv of src) {
      if (lv.bps > MAX_BPS) continue
      const key = Math.round(lv.px / step)
      const entry =
        buckets.get(key) ?? { usd: 0, zec: 0, venues: new Set<string>() }
      entry.usd += lv.usd
      entry.zec += lv.zec
      entry.venues.add(lv.venue)
      buckets.set(key, entry)
    }
    return [...buckets.entries()]
      .map(([key, v]) => {
        const price = key * step
        return {
          side,
          price: round(price, 2),
          usd: round(v.usd),
          zec: round(v.zec, 2),
          bps: round(Math.abs(((price - mid) / mid) * 10_000), 1),
          venues: v.venues.size,
        }
      })
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 4)
  }
  return [...collect(bidLevels, "bid"), ...collect(askLevels, "ask")].sort(
    (a, b) => b.usd - a.usd
  )
}

/** Walk the aggregated book filling `target` USD and return the VWAP the
 *  fill would print at. Null when the aggregated book (out to
 *  ±IMPACT_MAX_BPS) can't absorb the whole order. */
function fillVwap(levelsIn: AlignedLevel[], target: number): number | null {
  let remaining = target
  let zec = 0
  let spent = 0
  for (const lv of levelsIn) {
    const take = Math.min(remaining, lv.usd)
    zec += take / lv.px
    spent += take
    remaining -= take
    if (remaining <= 0) break
  }
  if (remaining > 0 || zec <= 0) return null
  return spent / zec
}

function buildImpact(
  bidLevels: AlignedLevel[],
  askLevels: AlignedLevel[],
  mid: number
): DepthImpactRow[] {
  return IMPACT_USD.map((usd) => {
    const buy = fillVwap(askLevels, usd)
    const sell = fillVwap(bidLevels, usd)
    return {
      usd,
      buyPrice: buy != null ? round(buy, 2) : null,
      sellPrice: sell != null ? round(sell, 2) : null,
      buyBps: buy != null ? round(((buy - mid) / mid) * 10_000, 1) : null,
      sellBps: sell != null ? round(((mid - sell) / mid) * 10_000, 1) : null,
    }
  })
}

// ---------- Tape ----------------------------------------------------------

function buildTape(
  perVenue: { venue: VenueDef; trades: RawTrade[] }[],
  now: number
): ZecDepthResponse["tape"] {
  const live = perVenue.filter((v) => v.trades.length > 0)
  const oldestByVenue = new Map(
    live.map((v) => [v.venue.id, Math.min(...v.trades.map((t) => t.ts))])
  )
  const windows: TapeWindow[] = TAPE_WINDOWS.map((minutes) => {
    const cutoff = now - minutes * 60_000
    // A venue only *covers* a window if the history we actually fetched
    // reaches back past the window start — otherwise a venue whose 1000
    // trades span 40 seconds would silently drag the 15-minute totals down.
    const covering = live.filter(
      (v) => (oldestByVenue.get(v.venue.id) ?? Infinity) <= cutoff
    )
    // Nothing covers the window (busy market vs the venues' trade-count
    // caps) — sum every venue's partial history rather than return zeros,
    // and report `covered: 0` so the UI says the total under-states reality
    // instead of claiming these venues had the full window. `covered` is
    // counted against `live`, not against the summed set: when only Kraken
    // reaches back 15 minutes we sum Kraken alone, and that total is still
    // missing the other venues' flow.
    const use = covering.length > 0 ? covering : live
    let buyUsd = 0
    let sellUsd = 0
    let trades = 0
    for (const v of use) {
      for (const t of v.trades) {
        if (t.ts < cutoff || t.ts > now + 60_000) continue
        const usd = t.price * t.size
        if (t.side === "buy") buyUsd += usd
        else sellUsd += usd
        trades++
      }
    }
    const total = buyUsd + sellUsd
    return {
      minutes,
      buyUsd: round(buyUsd),
      sellUsd: round(sellUsd),
      deltaUsd: round(buyUsd - sellUsd),
      pressure: total > 0 ? round(buyUsd / total, 4) : null,
      trades,
      venues: use.map((v) => v.venue.name),
      covered: covering.length,
      venuesLive: live.length,
    }
  })

  const all: TapePrint[] = []
  for (const v of live) {
    for (const t of v.trades) {
      const usd = t.price * t.size
      all.push({
        id: t.id,
        ts: t.ts,
        side: t.side,
        usd: round(usd),
        price: round(t.price, 2),
        zec: round(t.size, 4),
        venue: v.venue.name,
      })
    }
  }
  all.sort((a, b) => b.ts - a.ts)

  const printCutoff = now - PRINT_WINDOW_MS
  const prints = all
    .filter((p) => p.usd >= PRINT_MIN_USD && p.ts >= printCutoff)
    .slice(0, PRINT_LIMIT)

  // CVD over the last 15 minutes, restricted to the venues whose history
  // covers it so the curve doesn't step every time a short-history venue
  // drops in or out.
  //
  // The bucket grid is anchored on the CEILING of `now`, not the floor of
  // the cutoff: flooring left the final bucket ending at the last 30 s
  // boundary, so the newest 0-30 s of tape fell outside the grid and the
  // headline CVD figure could not move for up to five consecutive polls
  // before jumping.
  const bucketEnd = Math.ceil(now / CVD_BUCKET_MS) * CVD_BUCKET_MS
  const bucketStart = bucketEnd - CVD_BUCKETS * CVD_BUCKET_MS
  const cvdVenues = live.filter(
    (v) => (oldestByVenue.get(v.venue.id) ?? Infinity) <= bucketStart
  )
  const cvdUse = cvdVenues.length > 0 ? cvdVenues : live
  const deltas = new Array<number>(CVD_BUCKETS).fill(0)
  for (const v of cvdUse) {
    for (const t of v.trades) {
      const idx = Math.floor((t.ts - bucketStart) / CVD_BUCKET_MS)
      if (idx < 0 || idx >= CVD_BUCKETS) continue
      const usd = t.price * t.size
      deltas[idx] += t.side === "buy" ? usd : -usd
    }
  }
  let cum = 0
  const cvd: CvdPoint[] = deltas.map((d, i) => {
    cum += d
    return { ts: bucketStart + (i + 1) * CVD_BUCKET_MS, cum: round(cum) }
  })

  return {
    windows,
    prints,
    cvd,
    // On the wire so the UI's "no prints over $X in the last N minutes"
    // copy can't drift from the values that actually produced the list.
    minPrintUsd: PRINT_MIN_USD,
    printWindowMinutes: PRINT_WINDOW_MS / 60_000,
  }
}

// ---------- Intraday microstructure --------------------------------------

type Candle = {
  ts: number
  open: number
  high: number
  low: number
  close: number
  vwap: number
  volume: number
}

function parseKrakenOhlc(json: unknown): Candle[] {
  const rows = krakenPayload(json)
  if (!Array.isArray(rows)) return []
  const out: Candle[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const ts = num(row[0])
    const open = num(row[1])
    const high = num(row[2])
    const low = num(row[3])
    const close = num(row[4])
    const vwap = num(row[5])
    const volume = num(row[6])
    if (!Number.isFinite(ts) || !(close > 0)) continue
    out.push({
      ts: ts * 1000,
      open,
      high,
      low,
      close,
      vwap: vwap > 0 ? vwap : close,
      volume: volume > 0 ? volume : 0,
    })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** Annualized stdev of log returns, as a percentage. */
function realizedVol(closes: number[], periodsPerYear: number): number | null {
  if (closes.length < 12) return null
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]))
    }
  }
  if (rets.length < 10) return null
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance =
    rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100
}

function pctChange(from: number | undefined, to: number | undefined) {
  if (from == null || to == null || !(from > 0)) return null
  return round(((to - from) / from) * 100, 2)
}

function buildMicro(
  fiveMin: Candle[],
  hourly: Candle[]
): MicroStats | null {
  if (fiveMin.length === 0 && hourly.length === 0) return null
  const day = fiveMin.slice(-288)
  const price = fiveMin.at(-1)?.close ?? hourly.at(-1)?.close ?? null
  const high24h = day.length ? Math.max(...day.map((c) => c.high)) : null
  const low24h = day.length ? Math.min(...day.map((c) => c.low)) : null
  const volumeZec24h = day.length
    ? day.reduce((s, c) => s + c.volume, 0)
    : null
  const notional = day.reduce((s, c) => s + c.vwap * c.volume, 0)
  const vwap24h =
    volumeZec24h != null && volumeZec24h > 0 ? notional / volumeZec24h : null

  // ATR over the 5-minute bars of the last 24h, expressed as a % of price
  // so it reads next to the annualized vol numbers.
  let atr24hPct: number | null = null
  if (day.length > 2 && price != null && price > 0) {
    let sum = 0
    let n = 0
    for (let i = 1; i < day.length; i++) {
      const tr = Math.max(
        day[i].high - day[i].low,
        Math.abs(day[i].high - day[i - 1].close),
        Math.abs(day[i].low - day[i - 1].close)
      )
      if (Number.isFinite(tr)) {
        sum += tr
        n++
      }
    }
    if (n > 0) atr24hPct = round(((sum / n) / price) * 100, 3)
  }

  const closes5 = day.map((c) => c.close)
  const hourlyCloses = hourly.map((c) => c.close)
  const rangeSpan = high24h != null && low24h != null ? high24h - low24h : null

  return {
    price: price != null ? round(price, 2) : null,
    high24h: high24h != null ? round(high24h, 2) : null,
    low24h: low24h != null ? round(low24h, 2) : null,
    rangePct24h:
      rangeSpan != null && low24h != null && low24h > 0
        ? round((rangeSpan / low24h) * 100, 2)
        : null,
    vwap24h: vwap24h != null ? round(vwap24h, 2) : null,
    vwapPremiumBps:
      vwap24h != null && vwap24h > 0 && price != null
        ? round(((price - vwap24h) / vwap24h) * 10_000, 1)
        : null,
    // 5m bars: 12/hour * 24 * 365 = 105,120 per year.
    vol24hPct: (() => {
      const v = realizedVol(closes5, 105_120)
      return v != null ? round(v, 1) : null
    })(),
    vol7dPct: (() => {
      const v = realizedVol(hourlyCloses.slice(-168), 8_760)
      return v != null ? round(v, 1) : null
    })(),
    vol30dPct: (() => {
      const v = realizedVol(hourlyCloses.slice(-720), 8_760)
      return v != null ? round(v, 1) : null
    })(),
    atr24hPct,
    volumeZec24h: volumeZec24h != null ? round(volumeZec24h, 2) : null,
    high7d: hourly.length
      ? round(Math.max(...hourly.slice(-168).map((c) => c.high)), 2)
      : null,
    low7d: hourly.length
      ? round(Math.min(...hourly.slice(-168).map((c) => c.low)), 2)
      : null,
    high30d: hourly.length
      ? round(Math.max(...hourly.map((c) => c.high)), 2)
      : null,
    low30d: hourly.length
      ? round(Math.min(...hourly.map((c) => c.low)), 2)
      : null,
    trend: {
      m5: pctChange(fiveMin.at(-2)?.close, price ?? undefined),
      m15: pctChange(fiveMin.at(-4)?.close, price ?? undefined),
      h1: pctChange(fiveMin.at(-13)?.close, price ?? undefined),
      h4: pctChange(fiveMin.at(-49)?.close, price ?? undefined),
      h24: pctChange(fiveMin.at(-289)?.close, price ?? undefined),
    },
    candles: day.length
      ? {
          startTs: day[0].ts,
          endTs: day[day.length - 1].ts,
          stepMs: 5 * 60_000,
          closes: day.map((c) => round(c.close, 2)),
        }
      : null,
  }
}

// ---------- Caches --------------------------------------------------------

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
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

let lastSnapshot: ZecDepthResponse | null = null
let microCache: { data: MicroStats | null; fetchedAt: number } | null = null
let lastKvWrite = 0
/** The fan-out currently in progress, if any. Requests that arrive mid-build
 *  join it instead of starting their own — without this, the 5 s memory cache
 *  only protects requests arriving *after* a build finishes, so a slow
 *  upstream would let every poll launch a fresh fan-out. */
let inFlight: Promise<ZecDepthResponse | null> | null = null

async function loadMicro(now: number): Promise<MicroStats | null> {
  if (microCache && now - microCache.fetchedAt < MICRO_FRESH_TTL_MS) {
    return microCache.data
  }
  const [five, hour] = await Promise.all([
    fetchJson(
      "https://api.kraken.com/0/public/OHLC?pair=ZECUSD&interval=5"
    ).catch(() => null),
    fetchJson(
      "https://api.kraken.com/0/public/OHLC?pair=ZECUSD&interval=60"
    ).catch(() => null),
  ])
  const micro = buildMicro(
    five ? parseKrakenOhlc(five) : [],
    hour ? parseKrakenOhlc(hour) : []
  )
  // Keep the previous candles rather than blanking the panel if Kraken
  // rate-limited this particular refresh.
  if (micro == null && microCache?.data) return microCache.data
  microCache = { data: micro, fetchedAt: now }
  return micro
}

function fetchBooks() {
  return Promise.all(
    VENUES.map(async (def) => {
      try {
        const json = await fetchJson(def.bookUrl)
        const book = buildVenueBook(def, def.parseBook(json))
        if (!book) throw new Error("empty book")
        return { def, book, error: null as string | null }
      } catch (err) {
        return {
          def,
          book: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })
  )
}

function fetchTapes() {
  return Promise.all(
    VENUES.filter((v) => v.tradesUrl && v.parseTrades).map(async (def) => {
      try {
        const json = await fetchJson(def.tradesUrl as string)
        const trades = (def.parseTrades as (j: unknown) => RawTrade[])(json)
        return { venue: def, trades }
      } catch {
        return { venue: def, trades: [] as RawTrade[] }
      }
    })
  )
}

async function buildSnapshot(now: number): Promise<ZecDepthResponse | null> {
  // All three batches in ONE Promise.all: the tape and OHLC URLs are static,
  // not derived from the books, so awaiting them in series only stacked three
  // 7 s timeouts into a ~21 s worst case — longer than the client's own poll
  // interval, which then piled up concurrent fan-outs. Now the worst case is
  // one timeout.
  const [bookResults, tapeResults, micro] = await Promise.all([
    fetchBooks(),
    fetchTapes(),
    loadMicro(now),
  ])

  const books = bookResults
    .map((r) => r.book)
    .filter((b): b is VenueBook => b != null)
  if (books.length === 0) return null

  // Prefer the USD-quoted venues for the headline mid so the number on
  // screen is dollars, not tether.
  const usdBooks = books.filter((b) => b.def.pair.endsWith("/USD"))
  const mid = consensus(usdBooks.length > 0 ? usdBooks : books)
  if (mid == null || !(mid > 0)) return null

  const { bidLevels, askLevels } = aggregateBooks(books, mid)
  const bins = buildBins(bidLevels, askLevels)
  const ladder = buildLadder(bidLevels, askLevels)

  const bestBid = Math.max(...books.map((b) => b.bestBid * (mid / b.mid)))
  const bestAsk = Math.min(...books.map((b) => b.bestAsk * (mid / b.mid)))

  const depth1pct = books.reduce((s, b) => s + b.bidUsd + b.askUsd, 0)
  const venues: DepthVenue[] = bookResults.map((r) => {
    const b = r.book
    return {
      id: r.def.id,
      name: r.def.name,
      pair: r.def.pair,
      ok: b != null,
      error: r.error,
      mid: b ? round(b.mid, 2) : null,
      bestBid: b ? round(b.bestBid, 2) : null,
      bestAsk: b ? round(b.bestAsk, 2) : null,
      spreadBps: b ? round(((b.bestAsk - b.bestBid) / b.mid) * 10_000, 1) : null,
      bidUsd: b ? round(b.bidUsd) : 0,
      askUsd: b ? round(b.askUsd) : 0,
      depthUsd: b ? round(b.bidUsd + b.askUsd) : 0,
      share:
        b && depth1pct > 0 ? round((b.bidUsd + b.askUsd) / depth1pct, 4) : 0,
      basisBps: b ? round(((b.mid - mid) / mid) * 10_000, 1) : null,
      levels: b ? b.bids.length + b.asks.length : 0,
    }
  })

  const totalBid = bins.at(-1)?.bidCumUsd ?? 0
  const totalAsk = bins.at(-1)?.askCumUsd ?? 0
  const imb = (row: DepthLadderRow | undefined) => row?.imbalance ?? null

  return {
    mid: round(mid, 2),
    bestBid: round(bestBid, 2),
    bestAsk: round(bestAsk, 2),
    spreadBps: round(((bestAsk - bestBid) / mid) * 10_000, 2),
    bins,
    ladder,
    imbalance1pct: imb(ladder.find((r) => r.bps === 100)),
    walls: buildWalls(bidLevels, askLevels, mid),
    impact: buildImpact(bidLevels, askLevels, mid),
    venues,
    tape: buildTape(tapeResults, now),
    micro,
    totals: { bidUsd: totalBid, askUsd: totalAsk },
    maxBps: MAX_BPS,
    impactMaxBps: IMPACT_MAX_BPS,
    venuesOk: books.length,
    venuesTotal: VENUES.length,
    fetchedAt: now,
  }
}

export async function GET() {
  const now = Date.now()

  if (lastSnapshot && now - lastSnapshot.fetchedAt < FRESH_TTL_MS) {
    return NextResponse.json(lastSnapshot, { headers: RESPONSE_HEADERS })
  }

  try {
    // Coalesce concurrent builds onto one fan-out.
    const build = inFlight ?? (inFlight = buildSnapshot(now))
    let fresh: ZecDepthResponse | null
    try {
      fresh = await build
    } finally {
      if (inFlight === build) inFlight = null
    }
    if (fresh) {
      lastSnapshot = fresh
      const kv = await getKV()
      if (kv && now - lastKvWrite > KV_WRITE_MIN_SPACING_MS) {
        lastKvWrite = now
        try {
          await kv.put(KV_KEY, JSON.stringify(fresh))
        } catch {
          /* KV write budget / binding missing — non-fatal */
        }
      }
      return NextResponse.json(fresh, { headers: RESPONSE_HEADERS })
    }
  } catch (err) {
    console.warn(
      "[zec-depth] aggregation failed:",
      err instanceof Error ? err.message : String(err)
    )
  }

  if (lastSnapshot && now - lastSnapshot.fetchedAt < STALE_TTL_MS) {
    return NextResponse.json(
      { ...lastSnapshot, stale: true },
      { headers: RESPONSE_HEADERS }
    )
  }

  const kv = await getKV()
  if (kv) {
    try {
      const raw = await kv.get(KV_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ZecDepthResponse
        lastSnapshot = parsed
        return NextResponse.json(
          { ...parsed, stale: true },
          { headers: RESPONSE_HEADERS }
        )
      }
    } catch {
      /* fall through to the error response */
    }
  }

  return NextResponse.json(
    { error: "No order-book data available" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
