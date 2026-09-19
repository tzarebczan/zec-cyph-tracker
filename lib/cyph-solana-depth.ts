// Market depth for the tokenized CYPH share on Solana.
//
// The Solana side of CYPH is an AMM, not a central limit order book: there
// are no resting orders to list. What there is, and what a depth chart is
// actually asking, is "how much can I trade before the price moves" — and for
// a pool that question has an exact answer at every size.
//
// So we probe it. A geometric ladder of notional sizes is quoted through
// Jupiter (which routes across every pool holding the mint, fees included),
// giving cumulative shares fillable for each amount of USDC on each side.
// Differencing consecutive rungs turns that curve back into a ladder shaped
// like an order book: rung i holds the shares between rung i-1's fill and
// rung i's, priced at what that slice costs on average.
//
// Two things that ladder is NOT, both of which the UI states rather than
// buries:
//
//   1. Resting orders. Nobody has committed to these prices, and the pool
//      behind them can be withdrawn.
//   2. Exact at a price. A rung's price is the average over its own slice,
//      so the cumulative curve reads slightly deep: the last share of a
//      slice costs more than the slice's average. The error is bounded by
//      one slice's own impact, which is why the ladder starts small.
//
// Every figure here is therefore a sample of a cost curve, and the mid is
// the midpoint of the two smallest probes rather than the pool's spot price.
// They differ by about half the touch spread — which is why the panel labels
// the size each number was measured at.

import { CYPH_SOLANA_MINT } from "./cyph-247"
import type {
  CyphDepthLevel,
  CyphSolanaBook,
  CyphSolanaPool,
} from "@/components/api-types"

export type { CyphSolanaBook, CyphSolanaPool }

/** Circle's USDC on Solana — the quote asset for every probe, so the ladder
 *  is denominated in dollars rather than in SOL at some second exchange
 *  rate we would then have to defend. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

/** Both mints are 6-decimal today. A wrong exponent would silently scale the
 *  whole book by a power of ten, so rather than trust these constants the
 *  probe cross-checks its own derived price against DexScreener's before
 *  publishing anything — see `PRICE_SANITY_RATIO`. */
const CYPH_DECIMALS = 6
const USDC_DECIMALS = 6

/** Notional rungs, in USD. Geometric so the near-touch detail survives
 *  alongside a size that actually tests the pool. The top rung is where
 *  routing starts to fall apart on a pool this young; rungs past the point
 *  where the quote stops making sense are dropped rather than drawn. */
const LADDER_USD = [500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000] as const

/** A rung priced further than this from the mid is past the point of being a
 *  market. Jupiter will happily quote a 71% impact by routing through a dust
 *  pool; that is not depth. Applied to the outer rungs — the touch rungs
 *  define the mid, so they are policed by `MAX_TOUCH_SPREAD_BPS` instead. */
const MAX_IMPACT = 0.25

/** A round trip at the smallest probe costing more than this is not a market
 *  worth drawing a book for. Without it, two junk touch quotes would average
 *  into a junk mid that every later guard then measures against, and the
 *  whole book would look internally consistent while being nonsense. */
const MAX_TOUCH_SPREAD_BPS = 1_000

/** Widest the probe's own derived price may sit from DexScreener's, as a
 *  ratio. An independent feed is the only thing that catches a decimals
 *  change or a payload reshape: both would move the price by a power of ten
 *  while every internal consistency check still passed. */
const PRICE_SANITY_RATIO = 2

/** Total pool liquidity below this is too thin for the ladder to describe a
 *  market. Mirrors the floor the 24x7 price feed applies for the same reason. */
const MIN_LIQUIDITY_USD = 10_000

/** Fewer surviving rungs than this and the shape of the curve is guesswork.
 *  A rate-limited probe truncates at the first failure, and a two-rung book
 *  looks like a thin market rather than like the error it is. */
const MIN_RUNGS = 3

/** Slippage tolerance sent with the probe. High on purpose — we are asking
 *  what the fill would be, not placing anything, and a tight bound would make
 *  the deep rungs return nothing instead of returning the bad price that is
 *  the informative answer. */
const SLIPPAGE_BPS = 5_000

/** Two waves of quotes run back to back, so this is half the worst-case wait
 *  a first visitor can be made to sit through. */
const FETCH_TIMEOUT_MS = 4_000
const FRESH_TTL_MS = 45_000
/** Served while a refresh runs. A pool's shape changes with every swap, but a
 *  minute-old curve still answers "is there $20k of depth here" correctly,
 *  and that is the question this panel exists for. */
export const CYPH_SOLANA_DEPTH_STALE_TTL_MS = 10 * 60_000

interface Rung {
  notionalUsd: number
  cumShares: number
  cumNotional: number
  routes: string[]
}

function finite(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

function atomic(amount: number, decimals: number): string {
  return String(Math.max(1, Math.round(amount * 10 ** decimals)))
}

interface JupQuote {
  inAmount?: unknown
  outAmount?: unknown
  routePlan?: Array<{
    swapInfo?: { label?: unknown; inputMint?: unknown; outputMint?: unknown }
  }>
}

/** One Jupiter quote, or null when it failed. Never throws: a single bad rung
 *  should truncate the ladder, not lose the book. */
async function quote(
  inputMint: string,
  outputMint: string,
  amountAtomic: string
): Promise<JupQuote | null> {
  const url =
    "https://lite-api.jup.ag/swap/v1/quote" +
    `?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountAtomic}&slippageBps=${SLIPPAGE_BPS}`
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "cyphzec.com (+https://cyphzec.com/about)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as JupQuote & { error?: unknown }
    if (json?.error) return null
    return json
  } catch {
    return null
  }
}

/** Venue names for the legs that actually touch CYPH.
 *
 *  A route is rarely one hop: selling CYPH for USDC often goes CYPH → SOL →
 *  USDT → USDC, and naming every venue on that path would credit the CYPH
 *  book to whichever pool happened to bridge SOL into a stablecoin. Only legs
 *  with the mint on one side describe where CYPH liquidity lives. */
function routeLabels(q: JupQuote): string[] {
  const out: string[] = []
  for (const leg of q.routePlan ?? []) {
    const info = leg?.swapInfo
    const label = info?.label
    const touchesCyph =
      info?.inputMint === CYPH_SOLANA_MINT || info?.outputMint === CYPH_SOLANA_MINT
    if (!touchesCyph) continue
    if (typeof label === "string" && label && !out.includes(label)) out.push(label)
  }
  return out
}

/** Buy rungs: USDC in, CYPH out. Cumulative shares obtainable for each
 *  notional, in ladder order, truncated at the first rung that fails. */
async function buyRungs(): Promise<Rung[]> {
  const quotes = await Promise.all(
    LADDER_USD.map((usd) =>
      quote(USDC_MINT, CYPH_SOLANA_MINT, atomic(usd, USDC_DECIMALS))
    )
  )
  const out: Rung[] = []
  for (let i = 0; i < LADDER_USD.length; i += 1) {
    const q = quotes[i]
    if (!q) break
    const inAmt = finite(q.inAmount)
    const outAmt = finite(q.outAmount)
    if (inAmt == null || outAmt == null || outAmt <= 0) break
    out.push({
      notionalUsd: LADDER_USD[i],
      cumShares: outAmt / 10 ** CYPH_DECIMALS,
      cumNotional: inAmt / 10 ** USDC_DECIMALS,
      routes: routeLabels(q),
    })
  }
  return out
}

/** Sell rungs: CYPH in, USDC out. Sized from `reference`, a price we already
 *  have from the buy side, so both ladders carry the same dollar rungs and
 *  the two halves of the book are directly comparable. */
async function sellRungs(reference: number): Promise<Rung[]> {
  const quotes = await Promise.all(
    LADDER_USD.map((usd) =>
      quote(
        CYPH_SOLANA_MINT,
        USDC_MINT,
        atomic(usd / reference, CYPH_DECIMALS)
      )
    )
  )
  const out: Rung[] = []
  for (let i = 0; i < LADDER_USD.length; i += 1) {
    const q = quotes[i]
    if (!q) break
    const inAmt = finite(q.inAmount)
    const outAmt = finite(q.outAmount)
    if (inAmt == null || outAmt == null || inAmt <= 0 || outAmt <= 0) break
    out.push({
      notionalUsd: LADDER_USD[i],
      cumShares: inAmt / 10 ** CYPH_DECIMALS,
      cumNotional: outAmt / 10 ** USDC_DECIMALS,
      routes: routeLabels(q),
    })
  }
  return out
}

/** Marginal price and size between consecutive rungs — the ladder proper.
 *
 *  `side` decides which way prices must move as you go out: a buy fills
 *  worse (higher) with size, a sell fills worse (lower). A rung that breaks
 *  that, or that returns fewer cumulative shares than the rung inside it,
 *  means the router found a path that is not a market any more, and
 *  everything past it is dropped. */
function marginals(
  rungs: Rung[],
  side: "buy" | "sell"
): { px: number; sz: number; notional: number }[] {
  const out: { px: number; sz: number; notional: number }[] = []
  let prevShares = 0
  let prevNotional = 0
  let prevPx: number | null = null
  for (const r of rungs) {
    const sz = r.cumShares - prevShares
    const notional = r.cumNotional - prevNotional
    if (!(sz > 0) || !(notional > 0)) break
    const px = notional / sz
    if (!Number.isFinite(px) || px <= 0) break
    if (prevPx != null) {
      // Monotonic in the direction size hurts. A tiny wobble is rounding;
      // anything real means the ladder has stopped describing one market.
      const worse = side === "buy" ? px >= prevPx * 0.999 : px <= prevPx * 1.001
      if (!worse) break
    }
    out.push({ px, sz, notional })
    prevShares = r.cumShares
    prevNotional = r.cumNotional
    prevPx = px
  }
  return out
}

/** Realized USD tradeable before the *average* fill price is `pct` away from
 *  mid.
 *
 *  Measured in `cumNotional`, the dollars the quote actually moves, not the
 *  rung's label: a sell rung is sized in shares at the buy-side reference, so
 *  a "$500" sell realizes rather less than $500 once impact and fees are
 *  taken, and reporting the label would overstate the bid side.
 *
 *  Rounded down to the last rung still inside the band, so the figure is one
 *  a quote actually returned rather than a point invented between two of
 *  them. Zero means even the smallest probe was already outside — the band is
 *  narrower than the touch, not empty — and the UI renders that as "under the
 *  probe size" rather than as a dash. The outermost rung's value means the
 *  ladder never reached the edge, which `probedTopUsd` lets the UI mark as a
 *  floor. */
function depthWithin(
  rungs: Rung[],
  mid: number,
  side: "buy" | "sell",
  pct: number
): number | null {
  if (rungs.length === 0) return null
  const limit = side === "buy" ? mid * (1 + pct) : mid * (1 - pct)
  let prevNotional = 0
  for (const r of rungs) {
    const avg = r.cumNotional / r.cumShares
    const within = side === "buy" ? avg <= limit : avg >= limit
    if (!within) return prevNotional
    prevNotional = r.cumNotional
  }
  return prevNotional
}

async function fetchPools(): Promise<{
  pools: CyphSolanaPool[]
  totalLiquidityUsd: number | null
  volume24hUsd: number | null
  /** Deepest pool's own USD price, for the decimals / shape cross-check. */
  referencePriceUsd: number | null
}> {
  type Pair = {
    dexId?: string
    pairAddress?: string
    quoteToken?: { symbol?: string }
    baseToken?: { address?: string }
    priceUsd?: unknown
    liquidity?: { usd?: unknown }
    volume?: { h24?: unknown }
  }
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${CYPH_SOLANA_MINT}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    )
    if (!res.ok) throw new Error(String(res.status))
    const json = (await res.json()) as Pair[]
    if (!Array.isArray(json)) throw new Error("shape")
    const matching = json.filter((p) => p.baseToken?.address === CYPH_SOLANA_MINT)
    const pools = matching
      .map((p) => ({
        dex: p.dexId ?? "dex",
        pairAddress: p.pairAddress ?? "",
        quoteSymbol: p.quoteToken?.symbol ?? "?",
        liquidityUsd: finite(p.liquidity?.usd),
        volume24hUsd: finite(p.volume?.h24),
      }))
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    // The deepest pool's own quote, used only to sanity-check the price the
    // ladder derived. Independent of Jupiter, which is the point.
    const deepest = [...matching].sort(
      (a, b) => (finite(b.liquidity?.usd) ?? 0) - (finite(a.liquidity?.usd) ?? 0)
    )[0]
    const referencePriceUsd = deepest ? finite(deepest.priceUsd) : null
    const sum = (pick: (p: CyphSolanaPool) => number | null) => {
      const vals = pools.map(pick).filter((v): v is number => v != null)
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
    }
    return {
      pools,
      totalLiquidityUsd: sum((p) => p.liquidityUsd),
      volume24hUsd: sum((p) => p.volume24hUsd),
      referencePriceUsd,
    }
  } catch {
    return {
      pools: [],
      totalLiquidityUsd: null,
      volume24hUsd: null,
      referencePriceUsd: null,
    }
  }
}

async function buildBook(): Promise<CyphSolanaBook | null> {
  // Buy side first: its smallest rung prices the sell ladder, so both sides
  // carry the same dollar rungs without a second price source to reconcile.
  const [buys, poolInfo] = await Promise.all([buyRungs(), fetchPools()])
  if (buys.length < MIN_RUNGS) return null
  const reference = buys[0].cumNotional / buys[0].cumShares
  if (!Number.isFinite(reference) || reference <= 0) return null

  // Cross-check against a feed that shares none of this code path. A decimals
  // change, a reshaped payload or a quote for the wrong mint all move the
  // derived price by a large factor while every internal check still agrees
  // with itself; an outside number is the only thing that notices.
  const outside = poolInfo.referencePriceUsd
  if (outside != null && outside > 0) {
    const ratio = reference / outside
    if (ratio > PRICE_SANITY_RATIO || ratio < 1 / PRICE_SANITY_RATIO) {
      console.warn(
        `[cyph-solana-depth] probe priced CYPH at $${reference.toFixed(4)} ` +
          `against DexScreener's $${outside.toFixed(4)} — refusing the book`
      )
      return null
    }
  }
  if (
    poolInfo.totalLiquidityUsd != null &&
    poolInfo.totalLiquidityUsd < MIN_LIQUIDITY_USD
  ) {
    return null
  }

  const sells = await sellRungs(reference)
  if (sells.length < MIN_RUNGS) return null

  const askSide = marginals(buys, "buy")
  const bidSide = marginals(sells, "sell")
  // Both sides, not either: a one-sided book has no mid, and every figure
  // below is defined against one.
  if (askSide.length === 0 || bidSide.length === 0) return null

  // The touch rungs define the mid, so they cannot be policed against it.
  // What can be checked is the round trip they imply: two junk quotes average
  // into a junk mid that every later guard then agrees with, and the book
  // comes out internally consistent and completely wrong.
  const touchBid = bidSide[0].px
  const touchAsk = askSide[0].px
  const provisionalMid = (touchBid + touchAsk) / 2
  if (!(provisionalMid > 0)) return null
  const touchSpread = touchAsk - touchBid
  // Crossed: the two probes raced a swap between them. Real, transient, and
  // not something to render as a negative spread.
  if (!(touchSpread > 0)) return null
  if ((touchSpread / provisionalMid) * 10_000 > MAX_TOUCH_SPREAD_BPS) return null

  // Drop the outer rungs where the "price" is an artefact of routing rather
  // than a market. The touch rungs always survive: their distance from the
  // mid is half a spread that was just bounded well inside the cap.
  const keepWhile = <T extends { px: number }>(side: T[]): T[] => {
    const bad = side.findIndex(
      (l) => Math.abs(l.px - provisionalMid) / provisionalMid > MAX_IMPACT
    )
    return bad === -1 ? side : side.slice(0, bad)
  }
  const asks = keepWhile(askSide)
  const bids = keepWhile(bidSide)
  if (asks.length === 0 || bids.length === 0) return null

  // Everything headline is derived from rungs that survived, so a price can
  // never be printed for a level the ladder does not also show.
  const bestAsk = asks[0].px
  const bestBid = bids[0].px
  const mid = (bestBid + bestAsk) / 2
  const spread = bestAsk - bestBid

  const rows = Math.max(asks.length, bids.length)
  const levels: CyphDepthLevel[] = Array.from({ length: rows }, (_, i) => ({
    bidPx: bids[i]?.px ?? null,
    bidSz: bids[i] ? Math.round(bids[i].sz) : 0,
    bidCt: 0,
    askPx: asks[i]?.px ?? null,
    askSz: asks[i] ? Math.round(asks[i].sz) : 0,
    askCt: 0,
  }))

  // The raw rungs behind the levels that survived — the same rungs, so the
  // ±1% figures can never describe more of the curve than the ladder draws.
  const buysKept = buys.slice(0, asks.length)
  const sellsKept = sells.slice(0, bids.length)

  const bidShares = bids.reduce((a, l) => a + l.sz, 0)
  const askShares = asks.reduce((a, l) => a + l.sz, 0)
  const bidNotional = bids.reduce((a, l) => a + l.notional, 0)
  const askNotional = asks.reduce((a, l) => a + l.notional, 0)
  const totalShares = bidShares + askShares

  const routedVia: string[] = []
  for (const r of [...buysKept, ...sellsKept]) {
    for (const label of r.routes) {
      if (!routedVia.includes(label)) routedVia.push(label)
    }
  }

  return {
    mid,
    bestBid,
    bestAsk,
    spread,
    spreadBps: (spread / mid) * 10_000,
    touchNotionalUsd: LADDER_USD[0],
    probedTopUsd: {
      bid: sellsKept[sellsKept.length - 1].cumNotional,
      ask: buysKept[buysKept.length - 1].cumNotional,
    },
    levels,
    bidShares: Math.round(bidShares),
    askShares: Math.round(askShares),
    bidNotional,
    askNotional,
    imbalancePct:
      totalShares > 0 ? ((bidShares - askShares) / totalShares) * 100 : null,
    depth1PctUsd: {
      bid: depthWithin(sellsKept, mid, "sell", 0.01),
      ask: depthWithin(buysKept, mid, "buy", 0.01),
    },
    depth2PctUsd: {
      bid: depthWithin(sellsKept, mid, "sell", 0.02),
      ask: depthWithin(buysKept, mid, "buy", 0.02),
    },
    routedVia,
    pools: poolInfo.pools,
    totalLiquidityUsd: poolInfo.totalLiquidityUsd,
    volume24hUsd: poolInfo.volume24hUsd,
    at: Date.now(),
  }
}

// Per-isolate cache, stale-while-revalidate — the same shape as the 24x7
// price feed, for the same reason: one upstream probe (fifteen quotes) shared
// across every reader polling it.
let cache: { data: CyphSolanaBook; fetchedAt: number } | null = null
let inflight: Promise<CyphSolanaBook | null> | null = null

function refresh(): Promise<CyphSolanaBook | null> {
  if (!inflight) {
    inflight = buildBook()
      .catch((err) => {
        console.warn("[cyph-solana-depth] probe failed:", err)
        return null
      })
      .then((fresh) => {
        if (fresh) cache = { data: fresh, fetchedAt: Date.now() }
        return fresh
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Latest Solana book, or null when the pools could not be probed and nothing
 *  recent is cached. Never throws. */
export async function getCyphSolanaDepth(
  waitUntil?: (p: Promise<unknown>) => void
): Promise<CyphSolanaBook | null> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < FRESH_TTL_MS) return cache.data

  const pending = refresh()
  if (cache && now - cache.fetchedAt < CYPH_SOLANA_DEPTH_STALE_TTL_MS) {
    waitUntil?.(pending)
    return cache.data
  }
  const fresh = await pending
  if (fresh) return fresh
  // Re-read the clock: the await may have carried an almost-expired cache
  // past its window.
  const after = Date.now()
  return cache && after - cache.fetchedAt < CYPH_SOLANA_DEPTH_STALE_TTL_MS
    ? cache.data
    : null
}
