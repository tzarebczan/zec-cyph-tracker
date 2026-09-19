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
// Differencing consecutive rungs turns that curve back into a ladder in the
// same shape as an order book: rung i holds the shares available between
// rung i-1's average fill price and rung i's. Feeding that into the same
// `Ladder` / `DepthCurve` the Nasdaq book uses is not a cosmetic trick — the
// cumulative depth it draws is the real fillable size at that price, which is
// exactly what the equity curve plots.
//
// What it is NOT, and what the UI says plainly: resting orders. Nobody has
// committed to these prices. Pool liquidity can be withdrawn, and a rung is
// the pool's shape right now, not a queue of counterparties.

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

/** Both mints are 6-decimal. Asserted rather than assumed: a wrong exponent
 *  would silently scale the whole book by 10^n. */
const CYPH_DECIMALS = 6
const USDC_DECIMALS = 6

/** Notional rungs, in USD. Geometric so the near-touch detail survives
 *  alongside a size that actually tests the pool. The top rung is where
 *  routing starts to fall apart on a pool this young; rungs past the point
 *  where the quote stops making sense are dropped rather than drawn. */
const LADDER_USD = [500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000] as const

/** A rung whose average fill is further than this from the mid is past the
 *  point of being a market. Jupiter will happily quote a 71% impact by
 *  routing through a dust pool; that is not depth. */
const MAX_IMPACT = 0.25

/** Slippage tolerance sent with the probe. High on purpose — we are asking
 *  what the fill would be, not placing anything, and a tight bound would make
 *  the deep rungs return nothing instead of returning the bad price that is
 *  the informative answer. */
const SLIPPAGE_BPS = 5_000

const FETCH_TIMEOUT_MS = 6_000
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
      headers: { Accept: "application/json" },
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

/** Notional tradeable before the *average* fill price is `pct` away from mid.
 *  Rounded down to the last rung that was still inside the band, so the
 *  figure is one an actual quote returned rather than a point invented
 *  between two of them. Null when even the smallest rung is already outside;
 *  the outermost rung when the ladder never reaches that far, which reads as
 *  "at least this much". */
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
    if (within) {
      prevNotional = r.notionalUsd
      continue
    }
    // Straddled. The crossing sits between `prevNotional` and this rung; the
    // inner edge is the figure we can actually stand behind, so round down to
    // it rather than interpolate a number no quote returned.
    return prevNotional > 0 ? prevNotional : null
  }
  // Never crossed — the ladder is not deep enough to say. Report the whole
  // ladder as a floor rather than claiming an unmeasured number.
  return rungs[rungs.length - 1].notionalUsd
}

async function fetchPools(): Promise<{
  pools: CyphSolanaPool[]
  totalLiquidityUsd: number | null
  volume24hUsd: number | null
}> {
  type Pair = {
    dexId?: string
    pairAddress?: string
    quoteToken?: { symbol?: string }
    baseToken?: { address?: string }
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
    const pools = json
      .filter((p) => p.baseToken?.address === CYPH_SOLANA_MINT)
      .map((p) => ({
        dex: p.dexId ?? "dex",
        pairAddress: p.pairAddress ?? "",
        quoteSymbol: p.quoteToken?.symbol ?? "?",
        liquidityUsd: finite(p.liquidity?.usd),
        volume24hUsd: finite(p.volume?.h24),
      }))
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    const sum = (pick: (p: CyphSolanaPool) => number | null) => {
      const vals = pools.map(pick).filter((v): v is number => v != null)
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
    }
    return {
      pools,
      totalLiquidityUsd: sum((p) => p.liquidityUsd),
      volume24hUsd: sum((p) => p.volume24hUsd),
    }
  } catch {
    return { pools: [], totalLiquidityUsd: null, volume24hUsd: null }
  }
}

async function buildBook(): Promise<CyphSolanaBook | null> {
  // Buy side first: its smallest rung prices the sell ladder, so both sides
  // carry the same dollar rungs without a second price source to reconcile.
  const [buys, poolInfo] = await Promise.all([buyRungs(), fetchPools()])
  if (buys.length === 0) return null
  const reference = buys[0].cumNotional / buys[0].cumShares
  if (!Number.isFinite(reference) || reference <= 0) return null

  const sells = await sellRungs(reference)

  const askSide = marginals(buys, "buy")
  const bidSide = marginals(sells, "sell")
  if (askSide.length === 0 && bidSide.length === 0) return null

  const bestAsk = askSide[0]?.px ?? null
  const bestBid = bidSide[0]?.px ?? null
  const mid =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk)
  if (mid == null || mid <= 0) return null

  // Drop rungs past the point where the "price" is an artefact of routing
  // rather than a market. Done after the mid is fixed so the cut is measured
  // against a real reference.
  const withinImpact = (px: number) => Math.abs(px - mid) / mid <= MAX_IMPACT
  const asks = askSide.slice(
    0,
    askSide.findIndex((l) => !withinImpact(l.px)) === -1
      ? askSide.length
      : askSide.findIndex((l) => !withinImpact(l.px))
  )
  const bids = bidSide.slice(
    0,
    bidSide.findIndex((l) => !withinImpact(l.px)) === -1
      ? bidSide.length
      : bidSide.findIndex((l) => !withinImpact(l.px))
  )

  const rows = Math.max(asks.length, bids.length)
  const levels: CyphDepthLevel[] = Array.from({ length: rows }, (_, i) => ({
    bidPx: bids[i]?.px ?? null,
    bidSz: bids[i] ? Math.round(bids[i].sz) : 0,
    bidCt: 0,
    askPx: asks[i]?.px ?? null,
    askSz: asks[i] ? Math.round(asks[i].sz) : 0,
    askCt: 0,
  }))

  const bidShares = bids.reduce((a, l) => a + l.sz, 0)
  const askShares = asks.reduce((a, l) => a + l.sz, 0)
  const bidNotional = bids.reduce((a, l) => a + l.notional, 0)
  const askNotional = asks.reduce((a, l) => a + l.notional, 0)
  const totalShares = bidShares + askShares
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null

  const routedVia: string[] = []
  for (const r of [...buys, ...sells]) {
    for (const label of r.routes) {
      if (!routedVia.includes(label)) routedVia.push(label)
    }
  }

  return {
    mid,
    ladderTopUsd: LADDER_USD[LADDER_USD.length - 1],
    bestBid,
    bestAsk,
    spread,
    spreadBps: spread != null ? (spread / mid) * 10_000 : null,
    touchNotionalUsd: LADDER_USD[0],
    levels,
    bidShares: Math.round(bidShares),
    askShares: Math.round(askShares),
    bidNotional,
    askNotional,
    imbalancePct:
      totalShares > 0 ? ((bidShares - askShares) / totalShares) * 100 : null,
    depth1PctUsd: {
      bid: depthWithin(sells, mid, "sell", 0.01),
      ask: depthWithin(buys, mid, "buy", 0.01),
    },
    depth2PctUsd: {
      bid: depthWithin(sells, mid, "sell", 0.02),
      ask: depthWithin(buys, mid, "buy", 0.02),
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
