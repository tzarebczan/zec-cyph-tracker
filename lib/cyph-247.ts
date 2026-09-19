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
// exactly like /api/quote's Yahoo cache, so thirty clients polling every 30 s
// share one upstream call.

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
  /** Trailing-24h traded volume in USD when the feed reports it. */
  volume24hUsd: number | null
}

const FRESH_TTL_MS = 30_000
// On total upstream failure keep serving the last good price for a while —
// the alternative is silently regressing to Friday's close, which is exactly
// the gap this feed exists to fill.
const STALE_TTL_MS = 15 * 60_000
const FETCH_TIMEOUT_MS = 6_000

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
  return {
    price,
    time: Math.floor(Date.now() / 1000),
    source: "jupiter",
    venue: "Solana DEX aggregate",
    liquidityUsd: finite(entry?.liquidity),
    volume24hUsd: null,
  }
}

async function fetchDexScreener(): Promise<Cyph247Quote> {
  type Pair = {
    dexId?: string
    priceUsd?: unknown
    liquidity?: { usd?: unknown }
    volume?: { h24?: unknown }
    baseToken?: { address?: string }
  }
  const json = (await getJson(
    `https://api.dexscreener.com/tokens/v1/solana/${CYPH_SOLANA_MINT}`
  )) as Pair[]
  if (!Array.isArray(json)) throw new Error("dexscreener: unexpected shape")
  // Only pools where CYPH is the base token — a CYPH-quoted pool would report
  // the *other* asset's price in CYPH.
  const pools = json
    .filter((p) => p.baseToken?.address === CYPH_SOLANA_MINT)
    .map((p) => ({
      dex: p.dexId ?? "dex",
      price: finite(p.priceUsd),
      liquidity: finite(p.liquidity?.usd) ?? 0,
      volume: finite(p.volume?.h24),
    }))
    .filter((p) => p.price != null && p.price > 0)
    .sort((a, b) => b.liquidity - a.liquidity)
  const best = pools[0]
  if (!best || best.price == null) throw new Error("dexscreener: no CYPH pool")
  const dexName = best.dex.charAt(0).toUpperCase() + best.dex.slice(1)
  return {
    price: best.price,
    time: Math.floor(Date.now() / 1000),
    source: "dexscreener",
    venue: `${dexName} · Solana`,
    liquidityUsd: best.liquidity > 0 ? best.liquidity : null,
    volume24hUsd: best.volume,
  }
}

async function fetchGatePerp(): Promise<Cyph247Quote> {
  const json = (await getJson(
    "https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=CYPH_USDT"
  )) as Array<{ last?: unknown; volume_24h_settle?: unknown }>
  const t = Array.isArray(json) ? json[0] : null
  const price = finite(t?.last)
  if (price == null || price <= 0) throw new Error("gate: last missing")
  return {
    price,
    time: Math.floor(Date.now() / 1000),
    source: "gate-perp",
    venue: "Gate.io CYPH/USDT perp",
    liquidityUsd: null,
    volume24hUsd: finite(t?.volume_24h_settle),
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

/** Latest 24x7 CYPH price, or null when no feed answered and the cache has
 *  aged out. Never throws: the quote route must keep serving Nasdaq data even
 *  if every crypto venue is unreachable. */
export async function getCyph247Quote(): Promise<Cyph247Quote | null> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < FRESH_TTL_MS) return cache.data
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
  const fresh = await inflight
  if (fresh) return fresh
  if (cache && now - cache.fetchedAt < STALE_TTL_MS) return cache.data
  return null
}
