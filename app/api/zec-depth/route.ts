import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Aggregated ZEC order-book depth + trade tape + intraday microstructure.
//
// Powers three surfaces:
//   • the dashboard ZEC tile's toggle-able DEPTH strip
//   • the dashboard's full-width ORDER BOOK DEPTH section
//   • /stats -> ORDER FLOW
//
// ---------------------------------------------------------------------------
// Why aggregate, and how the books are stitched together
// ---------------------------------------------------------------------------
// No single exchange holds a meaningful share of ZEC liquidity, so a
// single-exchange depth chart is misleading. We pull the full L2 book from six
// exchanges and combine them into one book.
//
// Exchanges quote in different units (USD on Kraken/Coinbase, USDT elsewhere)
// and trade at a small basis to each other. Bucketing raw prices would smear
// the book: an exchange trading 30 bps rich would drop its asks *below* the
// consensus mid and manufacture crossed liquidity that nobody can actually
// trade. So we mid-align instead — every exchange's prices are scaled by
// `consensusMid / exchangeMid` before bucketing, which is the standard way to
// build an aggregated depth curve. The raw deviation each exchange was scaled
// by is reported back per-exchange as `basisBps` so nothing is hidden.
//
// The consensus mid itself is a depth-weighted average of the USD-quoted
// exchanges (Kraken, Coinbase) when either is up, so the headline mid is a
// real USD number rather than a USDT one. USDT exchanges only set the mid if
// both USD exchanges fail.
//
// ---------------------------------------------------------------------------
// Staying up when an exchange doesn't
// ---------------------------------------------------------------------------
// Six public REST endpoints polled every few seconds from shared cloud egress
// means something is always briefly unavailable. Three layers handle that, in
// order of preference:
//
//   1. Fallback hosts. Each exchange lists its book (and tape) sources in
//      preference order and we take the first that answers with a usable
//      payload. Only genuinely separate hosts are worth listing — a different
//      rate-limit bucket and a different outage, not another path on the same
//      box. Coinbase's Advanced Trade API backs up its Exchange API, and
//      `data-api.binance.vision` (Binance's own market-data mirror, which
//      does not 451 cloud egress the way `api.binance.com` does) fronts
//      Binance.
//   2. Carry-forward. If every source for one exchange fails, its last good
//      book keeps counting for CARRY_TTL_MS. Dropping an exchange outright
//      moved the aggregate by its whole share — Coinbase alone is around a
//      fifth of the ±1% depth — so the totals used to jump on a rate-limit
//      blip rather than on real flow. Mid-alignment re-centres the carried
//      book on the live consensus mid, so what is stale is the shape of one
//      book, not its price. Carried books are excluded from setting the
//      consensus mid and the touch, and are flagged in the response. A poll
//      where NOT ONE exchange answered is not published at all — carrying
//      six books at once is a total outage, not a blip, and restamping it
//      with a fresh `fetchedAt` would render as LIVE. It falls through to
//      (3) instead, which the UI shows as CACHED with the real age.
//   3. The KV mirror, for a cold start or a total upstream failure.
//
// The tape gets the same treatment from a different angle: every feed is a
// "most recent N trades" snapshot, and on a busy tape N can span less than a
// minute, so a single fetch cannot honestly fill a 15-minute window. We
// accumulate trades per exchange across polls (keyed by trade id, so the
// overlap dedupes) and track how far back each exchange's history reaches
// WITHOUT a gap. Only exchanges whose unbroken history spans a window count
// as covering it.
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
// A KV mirror (15 min expiry, written at most every 30 s) is the cold-start /
// total upstream failure fallback, matching the pattern in /api/prices and
// friends.

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
 *  bounded, because a couple of exchanges carry junk levels out at 100x mid. */
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
/** How far past the request timestamp a trade may be and still count.
 *  `now` is captured before the fan-out, so trades that print while we are
 *  fetching are legitimately newer than it; anything beyond this is an exchange
 *  with a skewed clock and gets dropped. Shared by the window totals and the
 *  CVD grid so the two can't disagree about what "too new" means. */
const TAPE_FUTURE_SLACK_MS = 60_000

/** Per-request upstream timeout, and the wall-clock budget for one
 *  exchange's whole chain of sources. Sources are tried in series, so
 *  without the chain budget listing a fallback would double the worst case
 *  for the entire fan-out. */
const SOURCE_TIMEOUT_MS = 7_000
const CHAIN_BUDGET_MS = 9_000
/** Below this there isn't enough time left for another attempt to be worth
 *  making. */
const MIN_ATTEMPT_MS = 2_000

/** How long a book that failed to refresh keeps counting toward the
 *  aggregate. An exchange dropping out for one poll used to move the totals
 *  by its whole share — Coinbase alone is a fifth of the ±1% depth — so
 *  the headline numbers jumped on rate-limit blips rather than on real flow.
 *  Carrying the last good book smooths that out; mid-alignment re-centres it
 *  on the live consensus, so what's stale is the SHAPE of one book, not its
 *  price. Ninety seconds rides out a blip without letting a genuinely dead
 *  feed sit in the aggregate. */
const CARRY_TTL_MS = 90_000
/** How much trade history to accumulate across polls, per exchange. Has to
 *  cover the longest tape window (15 min) and the large-print feed (10 min)
 *  with headroom, because a single fetch of an exchange's trade cap can span
 *  as little as a few minutes on a busy tape. */
const TAPE_KEEP_MS = 20 * 60_000
/** Cap on accumulated trades per exchange — a runaway backstop, deliberately
 *  set above what a busy feed actually prints so that TAPE_KEEP_MS is the
 *  binding constraint and not this. Binance is the yardstick: 1000 ZEC trades
 *  there span about 70 seconds, so TAPE_KEEP_MS of its tape is on the order of
 *  17k trades. When a volume spike does make this bind, the truncation moves
 *  `contiguousSince` forward and the affected windows correctly stop counting
 *  that exchange as covered. */
const TAPE_MAX_TRADES = 25_000
/** How stale an exchange's last successful trade fetch may be and still be
 *  treated as covering a window. Past this its recent history has a hole in
 *  it, so its totals understate flow and it stops counting as covered. */
const TAPE_FRESH_MS = 30_000

const FRESH_TTL_MS = 5_000
const MICRO_FRESH_TTL_MS = 60_000
const STALE_TTL_MS = 10 * 60_000
/** Bumped whenever the wire shape changes. A stale snapshot written by the
 *  previous deploy would otherwise be served to clients built against the new
 *  shape — `venues` vs `exchanges` here — which crashes them rather than
 *  degrading. A key bump just means the first cold instance after a deploy has
 *  no mirror to fall back on, which is the same position as any first deploy. */
const KV_KEY = "zec.depth.stale.v2"
const KV_WRITE_MIN_SPACING_MS = 30_000
/** How fresh a KV snapshot has to be for a colo that missed its own edge
 *  cache to serve it instead of fanning out. Deliberately small: KV is
 *  eventually consistent across colos, so a generous window would mean
 *  serving a snapshot noticeably older than its `fetchedAt` suggests is
 *  typical. At ten seconds it stays well inside the age the footer still
 *  calls LIVE, so nothing is presented as fresher than it is — and because
 *  it costs no extra writes, a miss is only a wasted read. */
const KV_WARM_TTL_MS = 10_000
/** Expiry on the KV mirror. Slightly longer than STALE_TTL_MS so the read-side
 *  age check stays the authority (KV expiry is eventually consistent), but
 *  short enough that a dormant deployment can't leave a snapshot sitting there
 *  for months. */
const KV_TTL_SECONDS = 15 * 60
/** Cache-Control on the copy we hand the colo cache. The client-facing header
 *  keeps `stale-while-revalidate`, which is a reasonable hint for a browser
 *  but not something we want governing a shared cache on a live feed — it
 *  would let a colo serve a body 25 s old. The stored copy gets a flat 5 s
 *  and nothing else. */
const EDGE_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=5",
  "Content-Type": "application/json",
}
const RESPONSE_HEADERS = {
  // Set explicitly because some paths build their Response by hand rather
  // than through NextResponse.json, which would otherwise default the body
  // to text/plain.
  "Content-Type": "application/json",
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
  exchanges: number
}

interface DepthImpactRow {
  usd: number
  buyBps: number | null
  sellBps: number | null
  buyPrice: number | null
  sellPrice: number | null
}

interface DepthExchange {
  id: string
  name: string
  pair: string
  /** Whether we have a usable book at all — live or carried. */
  ok: boolean
  /** True when this exchange failed to refresh and we are re-using its last
   *  good book. Its depth still counts, its touch and basis are `ageMs` old. */
  carried: boolean
  /** Age of the book in ms. Zero for a live fetch. */
  ageMs: number
  /** True when the primary host failed and a fallback answered. */
  fallback: boolean
  /** Set whenever the live fetch failed, including when we carried a book. */
  error: string | null
  mid: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number | null
  bidUsd: number
  askUsd: number
  depthUsd: number
  /** Share of the aggregate ±1% depth this exchange contributed. */
  share: number
  /** Exchange mid vs consensus mid, in bps. Signed; positive = trading rich. */
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
  /** Exchange names actually summed for this window. */
  exchanges: string[]
  /** How many live tape exchanges had trade history reaching back the whole
   *  window. Compare against `exchangesLive`: fewer means the totals
   *  under-state real flow, and zero means not even the exchanges that were
   *  summed had the full window. */
  covered: number
  /** Live tape exchanges in this snapshot, whether or not they covered. */
  exchangesLive: number
}

interface TapePrint {
  id: string
  ts: number
  side: "buy" | "sell"
  usd: number
  price: number
  zec: number
  exchange: string
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
  exchanges: DepthExchange[]
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
  /** Exchanges contributing a book, live or carried. */
  exchangesOk: number
  /** Of those, how many answered this poll. */
  exchangesLive: number
  exchangesTotal: number
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

/** One upstream URL plus the parser for its particular response shape. */
interface Source<T> {
  url: string
  parse: (json: unknown) => T
}

interface ExchangeDef {
  id: string
  name: string
  pair: string
  /** Book sources tried in order until one parses into a usable book. A
   *  fallback is only worth listing when it is a genuinely different host —
   *  a different rate-limit bucket and a different outage — not another path
   *  on the same one. */
  book: Source<RawBook>[]
  trades?: Source<RawTrade[]>[]
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

/** `[price, size]` pair arrays — the shape Kraken, Coinbase's Exchange API,
 *  OKX, Gate, MEXC and Binance all use for their book endpoints. */
function pairBook(json: unknown): RawBook {
  const book = json as { bids?: unknown; asks?: unknown } | null
  return { bids: levels(book?.bids), asks: levels(book?.asks) }
}

/** `{ pricebook: { bids: [{ price, size }] } }` — Coinbase's Advanced Trade
 *  book, which is a different shape on a different host to the Exchange
 *  API's pair arrays. */
function pricebookBook(json: unknown): RawBook {
  const pb = (json as { pricebook?: { bids?: unknown; asks?: unknown } } | null)
    ?.pricebook
  const side = (raw: unknown): Level[] =>
    Array.isArray(raw)
      ? levels(
          raw.map((row) => {
            const r = row as { price?: unknown; size?: unknown }
            return [r?.price, r?.size]
          })
        )
      : []
  return { bids: side(pb?.bids), asks: side(pb?.asks) }
}

/** Binance's `/api/v3/trades` shape, which MEXC clones field for field.
 *  `isBuyerMaker: false` means the buyer lifted the offer — an aggressive
 *  taker buy, the convention the rest of the tape uses. */
function binanceTrades(prefix: string) {
  return (json: unknown): RawTrade[] => {
    if (!Array.isArray(json)) return []
    const out: RawTrade[] = []
    for (const row of json) {
      const t = row as {
        id?: number | null
        price?: string
        qty?: string
        time?: number
        isBuyerMaker?: boolean
      }
      const price = num(t.price)
      const size = num(t.qty)
      const ts = num(t.time)
      if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
      out.push({
        // MEXC sends `id: null`, so key off the trade's own contents there.
        // Two prints identical in time, price and size then collapse into
        // one; that is rare, and under-counting is the safer error for a
        // flow read than double-counting one trade across polls.
        id: `${prefix}:${t.id ?? `${ts}-${price}-${size}`}`,
        ts,
        side: t.isBuyerMaker ? "sell" : "buy",
        price,
        size,
      })
    }
    return out
  }
}

/** OKX wraps its book in `data[0]`. Shared by the three hosts/endpoints we
 *  read it from, which all return the same shape. */
function okxBook(json: unknown): RawBook {
  return pairBook((json as { data?: unknown[] } | null)?.data?.[0])
}

/** OKX's `side` is the taker's, so no inversion. Shared by both hosts. */
function okxTrades(json: unknown): RawTrade[] {
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
}

/** Coinbase reports the MAKER side on both of its trade feeds — the Exchange
 *  API and the Advanced Trade ticker return the same side for the same
 *  `trade_id`, so one parser serves both. That is the opposite convention to
 *  Kraken/OKX/Gate, hence the inversion: "buy" means taker buy everywhere in
 *  our tape. Sharing `trade_id` also means the two sources dedupe against
 *  each other when we fail over between them mid-window. */
function coinbaseTrades(json: unknown): RawTrade[] {
  const rows = Array.isArray(json)
    ? json
    : ((json as { trades?: unknown[] } | null)?.trades ?? [])
  if (!Array.isArray(rows)) return []
  const out: RawTrade[] = []
  for (const row of rows) {
    const t = row as {
      trade_id?: number | string
      side?: string
      size?: string
      price?: string
      time?: string
    }
    const price = num(t.price)
    const size = num(t.size)
    const ts = Date.parse(t.time ?? "")
    if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
    const maker = String(t.side ?? "").toLowerCase()
    out.push({
      id: `coinbase:${t.trade_id ?? `${ts}-${price}`}`,
      ts,
      side: maker === "buy" ? "sell" : "buy",
      price,
      size,
    })
  }
  return out
}

const EXCHANGES: ExchangeDef[] = [
  {
    id: "kraken",
    name: "Kraken",
    pair: "ZEC/USD",
    book: [
      {
        url: "https://api.kraken.com/0/public/Depth?pair=ZECUSD&count=500",
        parse: (json) => pairBook(krakenPayload(json)),
      },
    ],
    trades: [
      {
        url: "https://api.kraken.com/0/public/Trades?pair=ZECUSD&count=1000",
        parse: (json) => {
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
    ],
  },
  {
    // Coinbase's Exchange API rate-limits by IP, and this runs on shared
    // Cloudflare egress, so it drops out for a poll or two at a time. The
    // Advanced Trade host is a separate bucket serving the same book, which
    // turns most of those blips into a successful second attempt.
    id: "coinbase",
    name: "Coinbase",
    pair: "ZEC/USD",
    book: [
      {
        url: "https://api.exchange.coinbase.com/products/ZEC-USD/book?level=2",
        parse: pairBook,
      },
      {
        url: "https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=ZEC-USD&limit=1000",
        parse: pricebookBook,
      },
    ],
    trades: [
      {
        url: "https://api.exchange.coinbase.com/products/ZEC-USD/trades?limit=1000",
        parse: coinbaseTrades,
      },
      {
        // Caps at 100 trades whatever `limit` asks for — around 40 seconds of
        // ZEC tape. Thin for a single fetch, but the accumulator fills the
        // window back in over the following polls.
        url: "https://api.coinbase.com/api/v3/brokerage/market/products/ZEC-USD/ticker?limit=100",
        parse: coinbaseTrades,
      },
    ],
  },
  {
    // OKX rate-limits per endpoint per IP, and on shared egress its book
    // call is the one we have watched return 429. Two fallbacks, each in a
    // different bucket: `app.okx.com` is a separate host, and `books-full`
    // is a separate endpoint on the main host (it also returns far more
    // levels, but it carries a tighter limit of its own, so it stays last).
    id: "okx",
    name: "OKX",
    pair: "ZEC/USDT",
    book: [
      {
        url: "https://www.okx.com/api/v5/market/books?instId=ZEC-USDT&sz=400",
        parse: okxBook,
      },
      {
        url: "https://app.okx.com/api/v5/market/books?instId=ZEC-USDT&sz=400",
        parse: okxBook,
      },
      {
        url: "https://www.okx.com/api/v5/market/books-full?instId=ZEC-USDT&sz=5000",
        parse: okxBook,
      },
    ],
    trades: [
      {
        url: "https://www.okx.com/api/v5/market/trades?instId=ZEC-USDT&limit=500",
        parse: okxTrades,
      },
      {
        url: "https://app.okx.com/api/v5/market/trades?instId=ZEC-USDT&limit=500",
        parse: okxTrades,
      },
    ],
  },
  {
    id: "gate",
    name: "Gate.io",
    pair: "ZEC/USDT",
    book: [
      {
        url: "https://api.gateio.ws/api/v4/spot/order_book?currency_pair=ZEC_USDT&limit=1000",
        parse: pairBook,
      },
    ],
    trades: [
      {
        url: "https://api.gateio.ws/api/v4/spot/trades?currency_pair=ZEC_USDT&limit=1000",
        parse: (json) => {
          if (!Array.isArray(json)) return []
          const out: RawTrade[] = []
          for (const row of json) {
            const t = row as {
              id?: string
              side?: string
              amount?: string
              price?: string
              create_time_ms?: string
            }
            const price = num(t.price)
            const size = num(t.amount)
            const ts = num(t.create_time_ms)
            if (!(price > 0) || !(size > 0) || !Number.isFinite(ts)) continue
            out.push({
              id: `gate:${t.id ?? `${ts}-${price}`}`,
              ts: Math.round(ts),
              // Gate's `side` is the taker's.
              side: t.side === "sell" ? "sell" : "buy",
              price,
              size,
            })
          }
          return out
        },
      },
    ],
  },
  {
    id: "mexc",
    name: "MEXC",
    pair: "ZEC/USDT",
    book: [
      {
        url: "https://api.mexc.com/api/v3/depth?symbol=ZECUSDT&limit=1000",
        parse: pairBook,
      },
    ],
    trades: [
      {
        url: "https://api.mexc.com/api/v3/trades?symbol=ZECUSDT&limit=1000",
        parse: binanceTrades("mexc"),
      },
    ],
  },
  {
    // Binance blocks a lot of cloud egress with a 451, which is why this
    // exchange sat permanently dark. It publishes the same market data on
    // several hostnames with independent block policies, and which of them
    // answers depends on where the request leaves from — the mirror works
    // from some networks and not others — so all three are listed and we
    // take whichever replies. They serve byte-identical payloads.
    //
    //   data-api.binance.vision  the documented public market-data mirror
    //   www.binance.com          the website's own API path
    //   api.binance.com          the canonical host, last because it is the
    //                            one we have actually watched return 451
    id: "binance",
    name: "Binance",
    pair: "ZEC/USDT",
    book: [
      {
        url: "https://data-api.binance.vision/api/v3/depth?symbol=ZECUSDT&limit=1000",
        parse: pairBook,
      },
      {
        url: "https://www.binance.com/api/v3/depth?symbol=ZECUSDT&limit=1000",
        parse: pairBook,
      },
      {
        url: "https://api.binance.com/api/v3/depth?symbol=ZECUSDT&limit=1000",
        parse: pairBook,
      },
    ],
    trades: [
      {
        url: "https://data-api.binance.vision/api/v3/trades?symbol=ZECUSDT&limit=1000",
        parse: binanceTrades("binance"),
      },
      {
        url: "https://www.binance.com/api/v3/trades?symbol=ZECUSDT&limit=1000",
        parse: binanceTrades("binance"),
      },
      {
        url: "https://api.binance.com/api/v3/trades?symbol=ZECUSDT&limit=1000",
        parse: binanceTrades("binance"),
      },
    ],
  },
]

/** Hostname alone, for error messages — the full URL with its query string
 *  is far too long for the tooltip these end up in. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function fetchJson(
  url: string,
  timeoutMs = SOURCE_TIMEOUT_MS
): Promise<unknown> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Try each source in order, returning the first whose response both fetches
 *  and survives `refine`. `refine` returning null rejects a technically-valid
 *  response that isn't actually usable — an empty or crossed book — so a
 *  200 with no levels fails over to the next host rather than being reported as
 *  this exchange's answer.
 *
 *  Reports the index that answered: 0 is the primary, anything higher means we
 *  are running on a fallback, which is worth surfacing rather than hiding.
 *
 *  When every source fails it throws ONE error naming what each host did.
 *  This used to throw only the last error, which turned out to hide exactly
 *  the thing we most wanted to know: Binance reported a bare `HTTP 451` from
 *  its main host while saying nothing about whether the mirror ahead of it
 *  had answered, failed, or been skipped for budget. */
async function fetchFirst<T, R>(
  sources: Source<T>[],
  refine: (value: T) => R | null
): Promise<{ value: R; sourceIndex: number }> {
  const deadline = Date.now() + CHAIN_BUDGET_MS
  const failures: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const host = hostOf(sources[i].url)
    const left = deadline - Date.now()
    // Out of budget. Sources are tried in series, so without this one
    // exchange's chain could stretch the whole fan-out past the client's
    // poll interval. In practice the failure that sends us to a fallback is
    // a fast HTTP error, not a timeout, so there is normally most of the
    // budget left when we get here. Recorded rather than silently dropped,
    // so "we never asked" doesn't read as "it said no".
    if (i > 0 && left < MIN_ATTEMPT_MS) {
      failures.push(`${host}: not tried (out of budget)`)
      continue
    }
    try {
      const timeout = Math.min(
        SOURCE_TIMEOUT_MS,
        Math.max(left, MIN_ATTEMPT_MS)
      )
      const value = refine(
        sources[i].parse(await fetchJson(sources[i].url, timeout))
      )
      if (value == null) throw new Error("empty response")
      return { value, sourceIndex: i }
    } catch (err) {
      failures.push(
        `${host}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  throw new Error(failures.join("; ") || "no sources")
}

// ---------- Aggregation ----------------------------------------------------

interface ExchangeBook {
  def: ExchangeDef
  bids: Level[]
  asks: Level[]
  bestBid: number
  bestAsk: number
  mid: number
  /** Notional resting within ±1% of this exchange's own mid, in quote
   *  units. */
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

function buildExchangeBook(
  def: ExchangeDef,
  raw: RawBook
): ExchangeBook | null {
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

/** Depth-weighted mean of an exchange set's mids. Falls back to a plain mean
 *  when nobody reported any ±1% depth (thin book / parse oddity). */
function consensus(books: ExchangeBook[]): number | null {
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
  exchange: string
}

function aggregateBooks(books: ExchangeBook[], mid: number) {
  const bidLevels: AlignedLevel[] = []
  const askLevels: AlignedLevel[] = []
  for (const b of books) {
    // Mid-align: fold each exchange's basis (and any USDT peg drift) out of
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
        exchange: b.def.id,
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
        exchange: b.def.id,
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
      { usd: number; zec: number; exchanges: Set<string> }
    >()
    for (const lv of src) {
      if (lv.bps > MAX_BPS) continue
      const key = Math.round(lv.px / step)
      const entry =
        buckets.get(key) ?? { usd: 0, zec: 0, exchanges: new Set<string>() }
      entry.usd += lv.usd
      entry.zec += lv.zec
      entry.exchanges.add(lv.exchange)
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
          exchanges: v.exchanges.size,
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
  perExchange: TapeResult[],
  now: number
): ZecDepthResponse["tape"] {
  const live = perExchange.filter((v) => v.trades.length > 0)
  const windows: TapeWindow[] = TAPE_WINDOWS.map((minutes) => {
    const cutoff = now - minutes * 60_000
    // An exchange only *covers* a window if the history we hold reaches back
    // past the window start without a gap, AND its most recent fetch is
    // fresh. Otherwise an exchange whose 1000 trades span 40 seconds would
    // silently drag the 15-minute totals down. Because we accumulate trades
    // across polls, an exchange that starts out covering only a minute grows
    // into full coverage after running for a while.
    const covering = live.filter(
      (v) => v.fresh && v.contiguousSince <= cutoff
    )
    // Nothing covers the window (busy market vs the exchanges' trade-count
    // caps) — sum every exchange's partial history rather than return zeros,
    // and report `covered: 0` so the UI says the total under-states reality
    // instead of claiming these exchanges had the full window. `covered` is
    // counted against `live`, not against the summed set: when only Kraken
    // reaches back 15 minutes we sum Kraken alone, and that total is still
    // missing the other exchanges' flow.
    const use = covering.length > 0 ? covering : live
    let buyUsd = 0
    let sellUsd = 0
    let trades = 0
    for (const v of use) {
      for (const t of v.trades) {
        if (t.ts < cutoff || t.ts > now + TAPE_FUTURE_SLACK_MS) continue
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
      exchanges: use.map((v) => v.exchange.name),
      covered: covering.length,
      exchangesLive: live.length,
    }
  })

  // Test the two cheap predicates before building anything: we hold up to
  // TAPE_KEEP_MS of tape per exchange, so materialising every trade as a
  // TapePrint to then keep twelve of them would be thousands of throwaway
  // objects per poll.
  const printCutoff = now - PRINT_WINDOW_MS
  const big: TapePrint[] = []
  for (const v of live) {
    for (const t of v.trades) {
      if (t.ts < printCutoff || t.ts > now + TAPE_FUTURE_SLACK_MS) continue
      const usd = t.price * t.size
      if (usd < PRINT_MIN_USD) continue
      big.push({
        id: t.id,
        ts: t.ts,
        side: t.side,
        usd: round(usd),
        price: round(t.price, 2),
        zec: round(t.size, 4),
        exchange: v.exchange.name,
      })
    }
  }
  big.sort((a, b) => b.ts - a.ts)
  const prints = big.slice(0, PRINT_LIMIT)

  // CVD over the last 15 minutes, restricted to the exchanges whose history
  // covers it so the curve doesn't step every time a short-history exchange
  // drops in or out.
  //
  // The bucket grid is anchored on the CEILING of `now`, not the floor of
  // the cutoff: flooring left the final bucket ending at the last 30 s
  // boundary, so the newest 0-30 s of tape fell outside the grid and the
  // headline CVD figure could not move for up to five consecutive polls
  // before jumping.
  const bucketEnd = Math.ceil(now / CVD_BUCKET_MS) * CVD_BUCKET_MS
  const bucketStart = bucketEnd - CVD_BUCKETS * CVD_BUCKET_MS
  const cvdExchanges = live.filter(
    (v) => v.fresh && v.contiguousSince <= bucketStart
  )
  const cvdUse = cvdExchanges.length > 0 ? cvdExchanges : live
  const deltas = new Array<number>(CVD_BUCKETS).fill(0)
  for (const v of cvdUse) {
    for (const t of v.trades) {
      if (t.ts < bucketStart || t.ts > now + TAPE_FUTURE_SLACK_MS) continue
      // Clamp into the final bucket rather than dropping. `bucketEnd` is
      // derived from `now`, which was captured BEFORE the fan-out, so when the
      // request starts shortly before a 30 s boundary any trade that prints
      // while we are fetching lands past the grid — dropping those silently
      // lost the newest second or two of tape on roughly one poll in twenty.
      // A trade a moment past the nominal end belongs in "the most recent
      // 30 s", which is exactly the last bucket. The future-slack guard above
      // still rejects an exchange whose clock is genuinely wrong.
      const idx = Math.min(
        CVD_BUCKETS - 1,
        Math.floor((t.ts - bucketStart) / CVD_BUCKET_MS)
      )
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

/** Cloudflare's per-colo cache. Workers do NOT cache their own responses —
 *  `s-maxage` is an instruction to a shared cache, and there is no shared
 *  cache in front of the Worker — so without this the header on our response
 *  does nothing and the only cache we have is `lastSnapshot`, which is
 *  per-instance. Measured on production before this existed: six sequential
 *  requests over ten seconds produced five distinct `fetchedAt` values, i.e.
 *  a full twelve-call fan-out on nearly every request, because requests land
 *  on instances that are mostly cold. That is a lot of load to put on six
 *  exchanges for data we already had.
 *
 *  Undefined under `next dev` (Node has no `caches`), so every use is
 *  guarded and the dev server simply runs uncached. */
interface EdgeCache {
  match: (req: Request) => Promise<Response | undefined>
  put: (req: Request, res: Response) => Promise<void>
}

function edgeCache(): EdgeCache | null {
  const c = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
  return c ?? null
}

/** Fixed key, so a stray query string or fragment can't split the cache into
 *  entries that each pay for their own fan-out. Built off the incoming
 *  request's own origin because the Cache API only accepts same-origin keys. */
function cacheKey(request: Request): Request | null {
  try {
    return new Request(new URL("/api/zec-depth", request.url).toString(), {
      method: "GET",
    })
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

/** Result of trying to refresh one exchange's book. `book` may be a carried
 *  copy of an earlier poll's — check `carried`/`ageMs` before trusting its
 *  prices. `error` is set whenever the live attempt failed, carried or not,
 *  so the reason an exchange is stale is never swallowed. */
interface BookResult {
  def: ExchangeDef
  book: ExchangeBook | null
  error: string | null
  carried: boolean
  ageMs: number
  /** Index into `def.book` that answered; > 0 means a fallback host. */
  sourceIndex: number
}

/** Last book each exchange successfully returned, for CARRY_TTL_MS
 *  carry-forward. Per-instance and best-effort, like the snapshot cache
 *  above: a cold instance simply has nothing to carry. */
const lastBooks = new Map<
  string,
  { book: ExchangeBook; fetchedAt: number; sourceIndex: number }
>()

function fetchBooks(now: number): Promise<BookResult[]> {
  return Promise.all(
    EXCHANGES.map(async (def): Promise<BookResult> => {
      try {
        const { value: book, sourceIndex } = await fetchFirst(
          def.book,
          (raw) => buildExchangeBook(def, raw)
        )
        lastBooks.set(def.id, { book, fetchedAt: now, sourceIndex })
        return { def, book, error: null, carried: false, ageMs: 0, sourceIndex }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const prev = lastBooks.get(def.id)
        if (prev && now - prev.fetchedAt <= CARRY_TTL_MS) {
          return {
            def,
            book: prev.book,
            error,
            carried: true,
            ageMs: now - prev.fetchedAt,
            sourceIndex: prev.sourceIndex,
          }
        }
        if (prev) lastBooks.delete(def.id)
        return {
          def,
          book: null,
          error,
          carried: false,
          ageMs: 0,
          sourceIndex: -1,
        }
      }
    })
  )
}

/** Rolling trade history for one exchange, accumulated across polls. */
interface TapeState {
  /** Trade id -> trade, pruned to TAPE_KEEP_MS on every merge. Keyed by id
   *  because every feed we read is a "most recent N trades" snapshot, so
   *  consecutive polls overlap heavily. */
  trades: Map<string, RawTrade>
  /** Newest timestamp the previous successful fetch carried, used to tell
   *  whether the next fetch overlapped it or skipped over a gap. */
  lastNewest: number
  /** Earliest point this exchange's stored history is believed gap-free
   *  from. A single fetch of a busy exchange's trade cap can span only a few
   *  minutes, so accumulating is what lets the 15-minute window be honest —
   *  but only while the polls actually overlap. A fetch whose oldest trade
   *  is newer than the last one's newest means we missed trades in between,
   *  so contiguity restarts there. */
  contiguousSince: number
  /** When this exchange last returned trades. Older than TAPE_FRESH_MS means
   *  the recent end of its history has a hole, whatever `contiguousSince`
   *  says about the far end. */
  lastOkAt: number
}

interface TapeResult {
  exchange: ExchangeDef
  trades: RawTrade[]
  /** Window start this exchange can honestly account for. */
  contiguousSince: number
  fresh: boolean
}

const tapes = new Map<string, TapeState>()

function mergeTape(
  def: ExchangeDef,
  incoming: RawTrade[],
  now: number
): TapeState {
  let state = tapes.get(def.id)
  if (!state) {
    state = {
      trades: new Map(),
      lastNewest: 0,
      contiguousSince: now,
      lastOkAt: 0,
    }
    tapes.set(def.id, state)
  }
  if (incoming.length > 0) {
    let oldest = Infinity
    let newest = 0
    for (const t of incoming) {
      if (t.ts > now + TAPE_FUTURE_SLACK_MS) continue
      if (t.ts < oldest) oldest = t.ts
      if (t.ts > newest) newest = t.ts
      state.trades.set(t.id, t)
    }
    if (newest > 0) {
      if (state.lastNewest === 0 || oldest > state.lastNewest) {
        // First fetch, or a gap: this fetch starts after the newest trade we
        // already held, so we missed whatever printed in between and our
        // unbroken history restarts here.
        state.contiguousSince = oldest
      } else {
        // Overlapped what we held. Each feed hands back one contiguous "most
        // recent N trades" window, so if this one reaches farther back than
        // anything we had credited, that extra stretch is gap-free too and we
        // should take credit for it. It happens whenever the trade rate falls
        // — a fixed trade count then spans more time — and without this a
        // window stayed marked partial long after we could honestly account
        // for it, since `contiguousSince` only ever moved forward.
        state.contiguousSince = Math.min(state.contiguousSince, oldest)
      }
      state.lastNewest = Math.max(state.lastNewest, newest)
      state.lastOkAt = now
    }
  }
  const floor = now - TAPE_KEEP_MS
  for (const [id, t] of state.trades) {
    if (t.ts < floor) state.trades.delete(id)
  }
  if (state.trades.size > TAPE_MAX_TRADES) {
    // Newest-first, drop the tail. Only reachable if one exchange prints far
    // more than TAPE_KEEP_MS of tape should hold.
    const keep = [...state.trades.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, TAPE_MAX_TRADES)
    state.trades = new Map(keep.map((t) => [t.id, t]))
    state.contiguousSince = Math.max(
      state.contiguousSince,
      keep.at(-1)?.ts ?? floor
    )
  }
  state.contiguousSince = Math.max(state.contiguousSince, floor)
  return state
}

function fetchTapes(now: number): Promise<TapeResult[]> {
  return Promise.all(
    EXCHANGES.filter((e) => e.trades && e.trades.length > 0).map(
      async (def): Promise<TapeResult> => {
        let incoming: RawTrade[] = []
        try {
          incoming = (
            await fetchFirst(def.trades as Source<RawTrade[]>[], (rows) =>
              rows.length > 0 ? rows : null
            )
          ).value
        } catch {
          // Nothing new this poll. The stored history is still valid — trades
          // don't go stale, they age out — so fall through and report what we
          // have, with `fresh` false so it stops counting as covering.
        }
        const state = mergeTape(def, incoming, now)
        return {
          exchange: def,
          trades: [...state.trades.values()],
          contiguousSince: state.contiguousSince,
          fresh: state.lastOkAt > 0 && now - state.lastOkAt <= TAPE_FRESH_MS,
        }
      }
    )
  )
}

async function buildSnapshot(now: number): Promise<ZecDepthResponse | null> {
  // All three batches in ONE Promise.all: the tape and OHLC URLs are static,
  // not derived from the books, so awaiting them in series only stacked three
  // 7 s timeouts into a ~21 s worst case — longer than the client's own poll
  // interval, which then piled up concurrent fan-outs. Now the worst case is
  // one timeout.
  const [bookResults, tapeResults, micro] = await Promise.all([
    fetchBooks(now),
    fetchTapes(now),
    loadMicro(now),
  ])

  const books = bookResults
    .map((r) => r.book)
    .filter((b): b is ExchangeBook => b != null)
  const liveBooks = bookResults
    .filter((r) => !r.carried)
    .map((r) => r.book)
    .filter((b): b is ExchangeBook => b != null)
  // Not one exchange answered. Carry-forward exists to smooth over a single
  // exchange's blip, not to manufacture a fresh-looking snapshot out of a
  // total outage: with no live book there is nothing honest to set the mid or
  // the touch from, and publishing would stamp a new `fetchedAt` on prices up
  // to CARRY_TTL_MS old. Bail, and let GET serve the previous snapshot
  // flagged `stale` with its real age — which the UI renders as CACHED
  // rather than LIVE. (`books` is a superset of `liveBooks`, so this also
  // covers the every-book-missing case.)
  if (liveBooks.length === 0) return null

  // Prefer the USD-quoted exchanges for the headline mid so the number on
  // screen is dollars, not tether. Live books only: mid-alignment folds every
  // carried book onto this mid, so letting one help set it would be circular,
  // and would pull the headline toward where ZEC was rather than where it is.
  const usdLive = liveBooks.filter((b) => b.def.pair.endsWith("/USD"))
  const mid = consensus(usdLive.length > 0 ? usdLive : liveBooks)
  if (mid == null || !(mid > 0)) return null

  const { bidLevels, askLevels } = aggregateBooks(books, mid)
  const bins = buildBins(bidLevels, askLevels)
  const ladder = buildLadder(bidLevels, askLevels)

  // The touch is a live quantity — a carried book's best bid/ask is whatever
  // it was a poll or two ago, and the spread it implies is not tradeable now.
  const bestBid = Math.max(...liveBooks.map((b) => b.bestBid * (mid / b.mid)))
  const bestAsk = Math.min(...liveBooks.map((b) => b.bestAsk * (mid / b.mid)))

  const depth1pct = books.reduce((s, b) => s + b.bidUsd + b.askUsd, 0)
  const exchanges: DepthExchange[] = bookResults.map((r) => {
    const b = r.book
    return {
      id: r.def.id,
      name: r.def.name,
      pair: r.def.pair,
      ok: b != null,
      carried: r.carried,
      ageMs: r.carried ? r.ageMs : 0,
      fallback: r.sourceIndex > 0,
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
    exchanges,
    tape: buildTape(tapeResults, now),
    micro,
    totals: { bidUsd: totalBid, askUsd: totalAsk },
    maxBps: MAX_BPS,
    impactMaxBps: IMPACT_MAX_BPS,
    exchangesOk: books.length,
    exchangesLive: liveBooks.length,
    exchangesTotal: EXCHANGES.length,
    fetchedAt: now,
  }
}

/** Hand a snapshot to the client, and store a copy in the colo cache so the
 *  other instances in this colo don't repeat the fan-out for the next 5 s. */
async function serveFresh(
  request: Request,
  snapshot: ZecDepthResponse
): Promise<Response> {
  const body = JSON.stringify(snapshot)
  const cache = edgeCache()
  const key = cache ? cacheKey(request) : null
  if (cache && key) {
    try {
      await cache.put(key, new Response(body, { headers: EDGE_CACHE_HEADERS }))
    } catch {
      /* Cache API unavailable or response rejected — non-fatal, just slower. */
    }
  }
  return new Response(body, { headers: RESPONSE_HEADERS })
}

export async function GET(request: Request) {
  const now = Date.now()

  // Tier 1: this instance already has a fresh build. Cheapest possible path,
  // so it stays ahead of the cache lookups.
  if (lastSnapshot && now - lastSnapshot.fetchedAt < FRESH_TTL_MS) {
    return NextResponse.json(lastSnapshot, { headers: RESPONSE_HEADERS })
  }

  // Tier 2: another instance in this colo built recently. This is the one
  // that does the real work — it collapses every viewer served by a colo
  // onto one fan-out per 5 s, however much the instances churn.
  const cache = edgeCache()
  const key = cache ? cacheKey(request) : null
  if (cache && key) {
    try {
      const hit = await cache.match(key)
      if (hit) return hit
    } catch {
      /* treat a cache error as a miss */
    }
  }

  // Tier 3: another colo built very recently. KV is global where the colo
  // cache is not, so this catches the cold-colo case for the price of one
  // read — but it is eventually consistent, hence the tight window. The
  // snapshot read here is kept for the failure path at the bottom, which
  // wants the same value under a far looser age bound; re-reading it there
  // would be a second round-trip for a string we already hold.
  const kv = await getKV()
  let mirror: ZecDepthResponse | null = null
  if (kv) {
    try {
      const raw = await kv.get(KV_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ZecDepthResponse
        if (Number.isFinite(parsed.fetchedAt)) mirror = parsed
      }
    } catch {
      /* unreadable mirror — fall through and build */
    }
  }
  if (mirror && now - mirror.fetchedAt < KV_WARM_TTL_MS) {
    lastSnapshot = mirror
    return serveFresh(request, mirror)
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
      if (kv && now - lastKvWrite > KV_WRITE_MIN_SPACING_MS) {
        lastKvWrite = now
        try {
          await kv.put(KV_KEY, JSON.stringify(fresh), {
            expirationTtl: KV_TTL_SECONDS,
          })
        } catch {
          /* KV write budget / binding missing — non-fatal */
        }
      }
      return serveFresh(request, fresh)
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

  // Cold start with every exchange down: fall back to the KV mirror read
  // above, but only inside the same stale horizon the in-memory path
  // enforces. An order book is worthless once it's minutes old — resting
  // walls get pulled — so serving an hours-old snapshot would be actively
  // misleading in a way a stale supply figure never is. Past the horizon
  // we'd rather 503 and let both surfaces show their "feed unavailable"
  // state.
  if (mirror) {
    const age = now - mirror.fetchedAt
    if (age < STALE_TTL_MS) {
      lastSnapshot = mirror
      return NextResponse.json(
        { ...mirror, stale: true },
        { headers: RESPONSE_HEADERS }
      )
    }
    console.warn(
      `[zec-depth] discarding KV snapshot ${Math.round(age / 1000)}s old`
    )
  }

  return NextResponse.json(
    { error: "No order-book data available" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
