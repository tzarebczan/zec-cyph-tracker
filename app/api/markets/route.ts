import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Top-N crypto market caps for the rankings page + the dashboard ZEC
// rank chip. CoinMarketCap's public web-api is the primary source —
// it's the same data that powers coinmarketcap.com, and using it means
// our market caps match what users see when they cross-check on CMC
// (specifically: CMC counts coins like DOGE at 169B circulating while
// CoinGecko subtracts a generic "non-circulating" estimate down to
// ~154B, which made our DOGE number ~$1.7B too low). CoinPaprika is
// the fallback — separate IP rate-limit pool, free, no auth — so a
// CMC outage or rate-limit doesn't blank the page.
//
// We cache in Workers KV for ~10 min — fresh enough that a top-20 rank
// shuffle shows up promptly, but more than aggressive enough that a
// burst of dashboard refreshes doesn't pound the upstream. Each CF
// region shares the same KV value so cross-region traffic costs the
// same as single-region.

const COINMARKETCAP_URL =
  "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing?start=1&limit=80&sortBy=market_cap&sortType=desc&convert=USD&cryptoType=all&tagType=all"
const COINPAPRIKA_URL =
  "https://api.coinpaprika.com/v1/tickers?limit=80"
// CoinGecko is used purely as a side-channel to enrich FDV when CMC's
// `fullyDilluttedMarketCap` collapses down to the regular mcap (which
// happens for coins where CMC has decided totalSupply == circulating
// — DOGE is the canonical example: CMC says 154B/154B, CG says
// 154B/169B, and the user expects "FDV" to mean the 169B figure).
// We only use it for the totalSupply × price calc; mcap stays sourced
// from CMC so the leaderboard's primary numbers don't drift between
// CMC and CG conventions.
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80&page=1&sparkline=false"

// v6: cache invalidation marker. Bumped from v5 when we started
// enriching `fdv` from CoinGecko's totalSupply for coins where CMC's
// reported FDV degenerates to the regular mcap. Old v5 entries don't
// have the enriched value and would surface the "broken" $16B DOGE
// FDV under the toggle until the natural 10m expiry kicked in.
const KV_KEY = "markets.top50.v6"
const KV_TTL_SECONDS = 10 * 60 // 10 minutes
// Long-lived mirror written on every successful fetch. No TTL, so when
// both CoinMarketCap and CoinPaprika are down — or our IP is rate-
// limited for an hour — we can still serve the last-known-good
// leaderboard instead of bombing the page with "Couldn't load market
// data". The fresh KV_KEY entry is preferred when present; this only
// activates after the 10m fresh-cache expires AND both upstreams fail.
const KV_STALE_KEY = "markets.top50.stale.v6"

// Symbols we strip from the leaderboard before re-ranking. Each entry
// is either a wrapped/staked derivative of a coin already in the list
// (so it'd otherwise double-count BTC or ETH market cap), or a niche
// tokenized real-world-asset that floats into the top-50 unpredictably
// without being something users compare ZEC against. Matches CMC's
// default top-N view, where ZEC sits at ~#13 instead of CoinGecko's
// ~#17. To bring back any of these, just remove the symbol — the UI
// will silently include it again.
const EXCLUDED_SYMBOLS = new Set([
  // Wrapped / staked / liquid-restaking versions of BTC and ETH
  "WBTC",
  "WSTETH",
  "STETH",
  "WETH",
  "METH",
  "RETH",
  "CBETH",
  "WBETH",
  "EZETH",
  "WEETH",
  // Tokenized RWA / mortgage products that briefly float top-50
  "FIGR_HELOC",
  // Stablecoins beyond the universally-tracked USDT / USDC. USDS is
  // Sky/MakerDAO's rebrand of DAI; USDe is Ethena's synthetic dollar.
  "USDS",
  "USDE",
  // Bridged / pegged variants
  "WBT",
])
// We pull 80 from each upstream so that after filtering we still
// reliably have enough rows to render a clean top-50.
const TARGET_TOP = 50

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface MarketCoin {
  rank: number
  symbol: string
  name: string
  id: string
  marketCap: number | null
  /** Fully diluted market cap — price × total/max supply. Used by the
   *  /stats leaderboard's FDV toggle so users can compare projects on
   *  long-run dilution rather than today's circulating mcap. Null when
   *  the upstream doesn't expose it and we can't derive one (no usable
   *  total/max supply). */
  fdv: number | null
  price: number | null
  change24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  image: string | null
}

interface MarketsResponse {
  coins: MarketCoin[]
  fetchedAt: number
  source: "coinmarketcap" | "coinpaprika"
  /** Symbols stripped from the upstream list before re-ranking — see
   *  EXCLUDED_SYMBOLS below for the rationale. */
  excluded: string[]
  /** Set when serving from the long-lived stale mirror because both
   *  upstreams failed. Clients can surface a small "cached" indicator. */
  stale?: boolean
}

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

interface CMCQuote {
  name?: string
  price?: number | null
  marketCap?: number | null
  // CMC's response field has a typo on the wire ("Dillutted" with two
  // t's and two l's). We map it to a sane name on the way out.
  fullyDilluttedMarketCap?: number | null
  percentChange24h?: number | null
}
interface CMCCoin {
  id?: number
  name?: string
  symbol?: string
  slug?: string
  cmcRank?: number | null
  circulatingSupply?: number | null
  totalSupply?: number | null
  maxSupply?: number | null
  quotes?: CMCQuote[]
}

type RawCoin = Omit<MarketCoin, "rank">

// CoinMarketCap's public web-api (the same endpoint that powers their
// public website — no API key required). Returns the upstream listing
// in CMC's ranking order; we re-rank after filtering.
async function fetchCoinMarketCap(): Promise<RawCoin[] | null> {
  try {
    const res = await fetch(COINMARKETCAP_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { cryptoCurrencyList?: CMCCoin[] }
    }
    const list = json?.data?.cryptoCurrencyList
    if (!Array.isArray(list)) return null
    return list
      .filter(
        (c) =>
          typeof c.cmcRank === "number" &&
          (c.cmcRank as number) > 0 &&
          c.quotes != null
      )
      .sort((a, b) => (a.cmcRank as number) - (b.cmcRank as number))
      .map((c) => {
        // CMC returns quotes as an array — pick the USD entry, or fall
        // back to the first one (the listing endpoint is convert=USD
        // so quotes[0] is reliably USD anyway).
        const usd = c.quotes?.find((q) => q.name === "USD") ?? c.quotes?.[0]
        return {
          symbol: (c.symbol ?? "").toUpperCase(),
          name: c.name ?? "",
          // Use the slug ("bitcoin", "dogecoin", …) as the stable id.
          // Matches the format CoinGecko used to return, so any client
          // code keying off `id` keeps working without changes.
          id: c.slug ?? (c.id != null ? String(c.id) : ""),
          marketCap: usd?.marketCap ?? null,
          fdv: usd?.fullyDilluttedMarketCap ?? null,
          price: usd?.price ?? null,
          change24h: usd?.percentChange24h ?? null,
          circulatingSupply: c.circulatingSupply ?? null,
          totalSupply: c.totalSupply ?? null,
          maxSupply: c.maxSupply ?? null,
          // CMC hosts per-coin logos at this predictable path keyed
          // off the numeric coin id. Same convention they use across
          // coinmarketcap.com itself.
          image:
            c.id != null
              ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${c.id}.png`
              : null,
        }
      })
  } catch {
    return null
  }
}

interface PaprikaTicker {
  id?: string
  name?: string
  symbol?: string
  rank?: number
  total_supply?: number
  max_supply?: number
  circulating_supply?: number
  quotes?: {
    USD?: {
      price?: number
      market_cap?: number
      percent_change_24h?: number
    }
  }
}

async function fetchCoinPaprika(): Promise<RawCoin[] | null> {
  try {
    const res = await fetch(COINPAPRIKA_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as PaprikaTicker[]
    return json
      .filter((c) => typeof c.rank === "number" && c.rank > 0 && c.rank <= 80)
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((c) => {
        const price = c.quotes?.USD?.price ?? null
        // Paprika doesn't expose FDV directly; derive it from price ×
        // (max supply, falling back to total supply). When neither is
        // present we leave it null and let the client fall back to
        // the regular mcap so the FDV toggle still renders something.
        const fdvSupply =
          c.max_supply && c.max_supply > 0
            ? c.max_supply
            : c.total_supply && c.total_supply > 0
              ? c.total_supply
              : null
        const fdv =
          price != null && fdvSupply != null ? price * fdvSupply : null
        return {
          symbol: (c.symbol ?? "").toUpperCase(),
          name: c.name ?? "",
          id: c.id ?? "",
          marketCap: c.quotes?.USD?.market_cap ?? null,
          fdv,
          price,
          change24h: c.quotes?.USD?.percent_change_24h ?? null,
          circulatingSupply: c.circulating_supply ?? null,
          totalSupply: c.total_supply ?? null,
          maxSupply: c.max_supply ?? null,
          // CoinPaprika hosts per-coin logos at a predictable path. Saves
          // the table from rendering as a wall of plain tickers when we
          // fall back to this source.
          image: c.id ? `https://static.coinpaprika.com/coin/${c.id}/logo.png` : null,
        }
      })
  } catch {
    return null
  }
}

interface CoinGeckoMarket {
  id?: string
  symbol?: string
  current_price?: number | null
  total_supply?: number | null
  max_supply?: number | null
  market_cap?: number | null
  fully_diluted_valuation?: number | null
}

interface CgFdvHint {
  /** Symbol uppercased, used as the lookup key. */
  symbol: string
  /** Best FDV we can derive from CG: their reported FDV, or
   *  price × max_supply, or price × total_supply — whichever exists. */
  fdv: number | null
  /** Tiebreaker: prefer the highest-mcap entry when CG has multiple
   *  rows for the same symbol (USDS comes to mind). */
  marketCap: number | null
}

// Side-channel CG fetch used purely to enrich CMC's FDV. CMC has
// recently started collapsing some coins' totalSupply down to equal
// circulating (DOGE in particular: 154B / 154B), which makes CMC's
// fullyDilluttedMarketCap equal the regular mcap and hides the real
// dilution picture. CG kept the broader convention (DOGE: 154B
// circulating, 169B total, FDV $18B), and that's the number users
// recognize when they say "DOGE is an $18B coin".
//
// We surface CG's view as `fdv` only when it's higher than CMC's; mcap
// stays sourced from CMC so the leaderboard's primary numbers don't
// drift between conventions. Symbol is the join key — robust to CMC
// and CG sometimes using different slugs for the same coin.
async function fetchCoinGeckoFdvHints(): Promise<Map<string, CgFdvHint> | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as CoinGeckoMarket[]
    if (!Array.isArray(json)) return null
    const out = new Map<string, CgFdvHint>()
    for (const c of json) {
      const symbol = (c.symbol ?? "").toUpperCase()
      if (!symbol) continue
      const price = c.current_price ?? null
      const supply = c.max_supply ?? c.total_supply ?? null
      const derivedFdv =
        price != null && supply != null && supply > 0 ? price * supply : null
      const fdv = c.fully_diluted_valuation ?? derivedFdv
      const hint: CgFdvHint = {
        symbol,
        fdv,
        marketCap: c.market_cap ?? null,
      }
      // If multiple CG entries collide on symbol (rare but real for
      // recycled tickers), keep the one with the highest reported
      // mcap — that's reliably the canonical / dominant project.
      const prev = out.get(symbol)
      if (
        !prev ||
        (hint.marketCap ?? 0) > (prev.marketCap ?? 0)
      ) {
        out.set(symbol, hint)
      }
    }
    return out
  } catch {
    return null
  }
}

export async function GET() {
  const kv = await getKV()
  // 1) KV hit
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as MarketsResponse
        if (Array.isArray(parsed.coins) && parsed.coins.length > 0) {
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=60" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Upstream chain. CMC is primary (so the displayed market caps
  //    line up with coinmarketcap.com); CoinPaprika is the safety net
  //    for when CMC rate-limits or 5xx's. We don't fall back to
  //    CoinGecko's leaderboard anymore — CG's "non-circulating supply"
  //    heuristic undercounts coins like DOGE, which was the bug the
  //    primary-switch was meant to fix.
  //
  //    CG runs in parallel as a SIDE-CHANNEL: we use its totalSupply
  //    only to enrich FDV when CMC's FDV equals its mcap. CG failing
  //    is non-fatal — we simply ship CMC's numbers as-is, which is
  //    strictly better than today.
  const [cmcRaw, cgFdvHints] = await Promise.all([
    fetchCoinMarketCap(),
    fetchCoinGeckoFdvHints(),
  ])
  let raw: RawCoin[] | null = cmcRaw
  let source: MarketsResponse["source"] = "coinmarketcap"
  if (!raw || raw.length === 0) {
    raw = await fetchCoinPaprika()
    source = "coinpaprika"
  }

  // Apply the CG-FDV enrichment now, while raw is still in
  // upstream order. We only override FDV when CG's value is strictly
  // higher — CMC stays authoritative for everything else, including
  // mcap. Skipping enrichment when raw came from Paprika keeps the
  // fallback behaving like the v5 contract (Paprika's price ×
  // max/total supply is already the "broader" definition; mixing in
  // CG would introduce a needless source-of-truth ambiguity).
  if (raw && raw.length > 0 && source === "coinmarketcap" && cgFdvHints) {
    raw = raw.map((c) => {
      const hint = cgFdvHints.get(c.symbol)
      if (!hint || hint.fdv == null) return c
      const cmcFdv = c.fdv ?? c.marketCap ?? 0
      if (hint.fdv > cmcFdv) {
        return { ...c, fdv: hint.fdv }
      }
      return c
    })
  }

  // 2b) Both upstreams failed. Fall back to the long-lived stale
  //     mirror so the leaderboard keeps rendering during a rate-limit
  //     or outage window. Mark the response as stale so a future
  //     client could surface a banner if it cares.
  if (!raw || raw.length === 0) {
    if (kv) {
      try {
        const stale = await kv.get(KV_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as MarketsResponse
          if (Array.isArray(parsed.coins) && parsed.coins.length > 0) {
            return NextResponse.json(
              { ...parsed, stale: true },
              { headers: { "Cache-Control": "public, max-age=60" } }
            )
          }
        }
      } catch {
        /* fall through to error */
      }
    }
    return NextResponse.json(
      { error: "All market-data upstreams failed" },
      { status: 502 }
    )
  }

  // Filter out wrapped / RWA / niche-stable tokens, then re-rank 1..N
  // by market cap. ZEC's rank in the response now matches what users
  // see on CMC's default top-N view (which excludes the same set),
  // and /api/zec-stats picks up the same ranks via its KV read.
  const coins: MarketCoin[] = raw
    .filter((c) => !EXCLUDED_SYMBOLS.has(c.symbol))
    .slice(0, TARGET_TOP)
    .map((c, i) => ({ rank: i + 1, ...c }))

  const payload: MarketsResponse = {
    coins,
    fetchedAt: Date.now(),
    source,
    /** Symbols filtered out before re-ranking. UI can surface this so
     *  users understand why ZEC's rank here is lower than on CoinGecko. */
    excluded: Array.from(EXCLUDED_SYMBOLS),
  }

  // 3) Persist — write both the fresh-cache and the long-lived stale
  //    mirror. Two separate writes (rather than one) so the stale key
  //    keeps surviving even when fresh has expired and we're between
  //    successful upstream fetches.
  if (kv) {
    const json = JSON.stringify(payload)
    try {
      await Promise.all([
        kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
        kv.put(KV_STALE_KEY, json), // no TTL — last-known-good
      ])
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
