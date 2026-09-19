// Round-the-clock CYPH price for the hours when every US equity venue is shut.
//
// Since 2026-09-18 Cypherpunk's stock also trades as a tokenized share on
// Solana (Backpack Securities issues it, Sunrise settles it, and it is
// redeemable 1:1 for the Nasdaq share). The token trades on Raydium and
// other Solana DEXes 24x7, so on weekends, holidays and the Friday-night gap
// there is finally a live market for CYPH — which is what the dashboard shows
// as the "24x7" price whenever `marketSessionState().current` is null.
//
// Three feeds, tried in order. All are anonymous and key-free:
//
//   1. Jupiter Price API v3 — Solana's routing aggregator. Its `usdPrice` is
//      a liquidity-weighted price across every pool holding the mint, so a
//      thin side pool can't skew it.
//   2. DexScreener — per-pool prices for the same mint. We take the deepest
//      pool (Raydium at launch) so the number is the venue where most of the
//      volume actually prints.
//   3. Gate.io CYPH/USDT perpetual — the CoinMarketCap "derivatives" listing.
//      A perp, not a share, so it is the last resort: it tracks the stock
//      through funding rather than redemption, and it is labelled as such.
//
// This module is server-only (fetches upstream) and keeps a per-isolate cache
// like /api/quote's Yahoo cache, so thirty clients polling every 30 s share
// one upstream call. It serves stale-while-revalidate: a caller with any
// cached print gets it immediately while the refresh runs behind the
// response, so the Nasdaq quote's 30 s fast path never waits on a DEX.

/** Solana mint of the Backpack Securities tokenized CYPH share. */
export const CYPH_SOLANA_MINT = "CYPHuMmCL1GxJWa2tsPhLKykC7GrHJTCHwbXD4g5uawK"

export type Cyph247Source = "jupiter" | "dexscreener" | "gate-perp"

export interface Cyph247Quote {
  /** USD price of one tokenized share (or one perp contract on the fallback). */
  price: number
  /** Unix seconds the price was observed. None of the feeds expose a trade
   *  timestamp, so this is the fetch instant — the UI treats it as fresh for
   *  a bounded window and otherwise drops back to the last Nasdaq print. */
  time: number
  source: Cyph247Source
  /** Human venue label for tooltips: "Raydium · Solana", "Gate.io perp". */
  venue: string
  /** Pool / aggregate liquidity in USD when the feed reports it. */
  liquidityUsd: number | null
}

const FRESH_TTL_MS = 30_000
/** How long a cached print stays servable after the feeds stop answering.
 *  Mirrored by `TOKEN_FRESH_MS` in components/quote-utils.ts — the client's
 *  own clock is the backstop for a tab that paused polling. */
export const CYPH_247_STALE_TTL_MS = 15 * 60_000
/** Per-feed budget. Three feeds in series is the cold-isolate worst case,
 *  and even that is bounded again by `COLD_WAIT_MS` below. */
const FETCH_TIMEOUT_MS = 4_000
/** With no cache at all, how long a response waits for the first print
 *  before going out without one. Nasdaq data must not sit behind a DEX. */
const COLD_WAIT_MS = 1_500
/** A pool thinner than this can be moved a long way by one swap; a price
 *  from it should not become the sitewide headline. Jupiter's aggregate
 *  liquidity and DexScreener's per-pool liquidity are both checked. */
const MIN_LIQUIDITY_USD = 10_000

let cache: { data: Cyph247Quote; fetchedAt: number } | null = null
let inflight: Promise<Cyph247Quote | null> | null = null

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "cyphzec.com (+https://cyphzec.com/about)",
}

function finite(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
  return res.json()
}

async function fetchJupiter(): Promise<Cyph247Quote> {
  const json = (await getJson(
    `https://lite-api.jup.ag/price/v3?ids=${CYPH_SOLANA_MINT}`
  )) as Record<string, { usdPrice?: unknown; liquidity?: unknown }>
  const entry = json?.[CYPH_SOLANA_MINT]
  const price = finite(entry?.usdPrice)
  if (price == null || price <= 0) throw new Error("jupiter: usdPrice missing")
  const liquidityUsd = finite(entry?.liquidity)
  if (liquidityUsd != null && liquidityUsd < MIN_LIQUIDITY_USD) {
    throw new Error(`jupiter: liquidity too thin ($${Math.round(liquidityUsd)})`)
  }
  return {
    price,
    time: Math.floor(Date.now() / 1000),
    source: "jupiter",
    venue: "Solana DEX aggregate",
    liquidityUsd,
  }
}

async function fetchDexScreener(): Promise<Cyph247Quote> {
  type Pair = {
    dexId?: string
    priceUsd?: unknown
    liquidity?: { usd?: unknown }
    baseToken?: { address?: string }
  }
  const json = (await getJson(
    `https://api.dexscreener.com/tokens/v1/solana/${CYPH_SOLANA_MINT}`
  )) as Pair[]
  if (!Array.isArray(json)) throw new Error("dexscreener: unexpected shape")
  // Only pools where CYPH is the base token — a CYPH-quoted pool would report
  // the *other* asset's price in CYPH — and only pools deep enough to trust.
  const pools = json
    .filter((p) => p.baseToken?.address === CYPH_SOLANA_MINT)
    .map((p) => ({
      dex: p.dexId ?? "dex",
      price: finite(p.priceUsd),
      liquidity: finite(p.liquidity?.usd) ?? 0,
    }))
    .filter(
      (p) => p.price != null && p.price > 0 && p.liquidity >= MIN_LIQUIDITY_USD
    )
    .sort((a, b) => b.liquidity - a.liquidity)
  const best = pools[0]
  if (!best || best.price == null) {
    throw new Error("dexscreener: no CYPH pool above the liquidity floor")
  }
  const dexName = best.dex.charAt(0).toUpperCase() + best.dex.slice(1)
  return {
    price: best.price,
    time: Math.floor(Date.now() / 1000),
    source: "dexscreener",
    venue: `${dexName} · Solana`,
    liquidityUsd: best.liquidity,
  }
}

async function fetchGatePerp(): Promise<Cyph247Quote> {
  const json = (await getJson(
    "https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=CYPH_USDT"
  )) as Array<{ last?: unknown }>
  const t = Array.isArray(json) ? json[0] : null
  const price = finite(t?.last)
  if (price == null || price <= 0) throw new Error("gate: last missing")
  return {
    price,
    time: Math.floor(Date.now() / 1000),
    source: "gate-perp",
    venue: "Gate.io CYPH/USDT perp",
    liquidityUsd: null,
  }
}

async function fetchFresh(): Promise<Cyph247Quote | null> {
  const errors: string[] = []
  for (const fn of [fetchJupiter, fetchDexScreener, fetchGatePerp]) {
    try {
      return await fn()
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  console.warn("[cyph-247] every 24x7 feed failed:", errors)
  return null
}

/** Start (or join) the one refresh in flight for this isolate. */
function refresh(): Promise<Cyph247Quote | null> {
  if (!inflight) {
    inflight = fetchFresh()
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

function servable(at: number): Cyph247Quote | null {
  return cache && at - cache.fetchedAt < CYPH_247_STALE_TTL_MS ? cache.data : null
}

/** Latest 24x7 CYPH print, or null when nothing usable is known.
 *
 *  Fresh cache → returned at once. Stale-but-servable cache → returned at
 *  once while a refresh runs behind it (hand `waitUntil` in so the Workers
 *  runtime keeps the refresh alive past the response). No cache at all →
 *  waits at most `COLD_WAIT_MS` for the first print, then gives up for this
 *  response; the refresh keeps running for the next one.
 *
 *  Never throws: the quote route must keep serving Nasdaq data even if
 *  every crypto venue is unreachable. */
export async function getCyph247Quote(
  waitUntil?: (p: Promise<unknown>) => void
): Promise<Cyph247Quote | null> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < FRESH_TTL_MS) return cache.data

  const pending = refresh()
  const known = servable(now)
  if (known) {
    waitUntil?.(pending)
    return known
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COLD_WAIT_MS)
  })
  try {
    const fresh = await Promise.race([pending, gaveUp])
    if (fresh) return fresh
    waitUntil?.(pending)
    // Re-read the clock: the wait above may have carried an almost-expired
    // cache past its window, and it must not be served as if it had not.
    return servable(Date.now())
  } finally {
    if (timer) clearTimeout(timer)
  }
}
