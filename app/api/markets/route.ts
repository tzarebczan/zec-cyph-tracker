import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Top-N crypto market caps for the rankings page + the dashboard ZEC
// rank chip. CoinMarketCap's public listings web-api is the primary
// source — the same payload that hydrates coinmarketcap.com's homepage
// rankings table.
//
// CMC occasionally bugs out on DOGE and reports all-mined coins
// (~171B) as circulating, which inflates mcap to ~$15.8B and shoves
// DOGE a rank ahead of ZEC. The correct circulating figure is the
// ~155B "in circulation" number CMC (and CoinGecko) use the rest of
// the time. When a listing comes in inflated we:
//   • pin DOGE to last-good canonical circulating, or CoinGecko's
//     circulating_supply, which stays on ~155B
//   • recompute mcap from the live CMC price × that supply
//   • refuse to write the inflated row as last-good
// Prefer an older cached rank over a live wrong one.
//
// CoinPaprika is last-resort only. It uses yet another circulating
// convention (~148B), so we NEVER write a paprika payload over the
// last-good CMC snapshot.
//
// KV TTL is 60s (Cloudflare's minimum). Rank-adjacent coins move
// enough that a 10-minute snapshot was showing the wrong ZEC/DOGE
// order. Dashboard refreshes share one KV value per region, so this
// is one CMC fetch a minute globally, not one per visitor.

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

// v10: invert the DOGE pin. v9 treated ~171B as last-good and rejected
// the ~155B circulating figure; CMC's bug is the opposite — it
// occasionally reports all-mined (~171B) as circulating. New keys so
// a v9 171B snapshot cannot keep ranking DOGE ahead of ZEC.
const KV_KEY = "markets.top50.v10"
const KV_TTL_SECONDS = 60
const KV_STALE_KEY = "markets.top50.stale.v10"
// Last-good *canonical* DOGE circulating (~155B). Written only when
// the figure is below the inflated-total threshold.
const KV_DOGE_CIRC_KEY = "markets.doge.circ.v2"
// 165B sits between canonical circulating (~155B) and all-mined (~171B).
const DOGE_INFLATED_CIRC_MIN = 165_000_000_000
// Floor so a junk 0 / tiny figure can't become last-good.
const DOGE_CANONICAL_CIRC_MIN = 140_000_000_000
const CMC_DOGE_ID = 74
const CMC_DOGE_DETAIL_URL = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id=${CMC_DOGE_ID}`

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
  circulating_supply?: number | null
  total_supply?: number | null
  max_supply?: number | null
  market_cap?: number | null
  fully_diluted_valuation?: number | null
}

interface CgFdvHint {
  /** Symbol uppercased, used as the lookup key. */
  symbol: string
  fdv: number | null
  marketCap: number | null
  circulatingSupply: number | null
  /** CG total_supply — used only for the FDV toggle, not mcap. */
  totalSupply: number | null
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
        circulatingSupply:
          typeof c.circulating_supply === "number" && c.circulating_supply > 0
            ? c.circulating_supply
            : null,
        totalSupply:
          typeof c.total_supply === "number" && c.total_supply > 0
            ? c.total_supply
            : typeof c.max_supply === "number" && c.max_supply > 0
              ? c.max_supply
              : null,
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

interface CmcDogePin {
  price: number | null
  marketCap: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  change24h: number | null
}

// CMC's per-coin detail quote. Sometimes the listing inflates DOGE
// circulating to ~171B while this endpoint still has the canonical
// ~155B figure (or vice versa). We only apply it when it's canonical.
async function fetchCmcDogePin(): Promise<CmcDogePin | null> {
  try {
    const res = await fetch(CMC_DOGE_DETAIL_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: {
        statistics?: {
          price?: number | null
          marketCap?: number | null
          circulatingSupply?: number | null
          totalSupply?: number | null
          priceChangePercentage24h?: number | null
        }
      }
    }
    const s = json?.data?.statistics
    if (!s || typeof s.marketCap !== "number") return null
    return {
      price: typeof s.price === "number" ? s.price : null,
      marketCap: s.marketCap,
      circulatingSupply:
        typeof s.circulatingSupply === "number" ? s.circulatingSupply : null,
      totalSupply: typeof s.totalSupply === "number" ? s.totalSupply : null,
      change24h:
        typeof s.priceChangePercentage24h === "number"
          ? s.priceChangePercentage24h
          : null,
    }
  } catch {
    return null
  }
}

function dogeIsInflated(circ: number | null | undefined): boolean {
  return typeof circ === "number" && circ >= DOGE_INFLATED_CIRC_MIN
}

function dogeIsCanonical(circ: number | null | undefined): circ is number {
  return (
    typeof circ === "number" &&
    Number.isFinite(circ) &&
    circ >= DOGE_CANONICAL_CIRC_MIN &&
    circ < DOGE_INFLATED_CIRC_MIN
  )
}

function firstCanonical(
  ...vals: Array<number | null | undefined>
): number | null {
  for (const n of vals) {
    if (dogeIsCanonical(n)) return n
  }
  return null
}

function payloadDogeInflated(payload: MarketsResponse): boolean {
  const doge = payload.coins.find((c) => c.symbol === "DOGE")
  return dogeIsInflated(doge?.circulatingSupply)
}

function collectDogeCanonicalCirc(
  listing: RawCoin[] | null,
  pin: CmcDogePin | null,
  cg: CgFdvHint | null,
  lastGood: number | null
): number | null {
  const doge = listing?.find((c) => c.symbol === "DOGE")
  // Prefer live CMC when it's already canonical, then CG circulating
  // (stays ~155B through CMC's 171B blips), then last-good, then
  // the per-coin detail quote if that one didn't inflate.
  return firstCanonical(
    doge?.circulatingSupply,
    cg?.circulatingSupply,
    lastGood,
    pin?.circulatingSupply
  )
}

// If DOGE circulating is the all-mined 171B bug, rewrite it to the
// canonical ~155B figure and recompute mcap from the live price.
function applyDogeCanonicalCirc(
  raw: RawCoin[],
  canonical: number | null
): RawCoin[] {
  if (!dogeIsCanonical(canonical)) return raw
  return raw.map((c) => {
    if (c.symbol !== "DOGE") return c
    if (dogeIsCanonical(c.circulatingSupply)) return c
    const price = c.price
    return {
      ...c,
      circulatingSupply: canonical,
      marketCap: price != null ? price * canonical : c.marketCap,
    }
  })
}

async function readDogeCanonicalCirc(
  kv: KVLike | null
): Promise<number | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(KV_DOGE_CIRC_KEY)
    if (!raw) return null
    const n = Number(raw)
    return dogeIsCanonical(n) ? n : null
  } catch {
    return null
  }
}

async function writeDogeCanonicalCirc(
  kv: KVLike | null,
  circ: number | null
): Promise<void> {
  if (!kv || !dogeIsCanonical(circ)) return
  try {
    await kv.put(KV_DOGE_CIRC_KEY, String(circ))
  } catch {
    /* best-effort */
  }
}

// Overlay CMC's DOGE detail onto the listing only when the detail
// quote is canonical (not the 171B bug) and the listing is inflated.
function pinDogeToCmc(raw: RawCoin[], pin: CmcDogePin | null): RawCoin[] {
  if (!pin || !dogeIsCanonical(pin.circulatingSupply)) return raw
  return raw.map((c) => {
    if (c.symbol !== "DOGE") return c
    if (dogeIsCanonical(c.circulatingSupply)) return c
    const price = pin.price ?? c.price
    return {
      ...c,
      price,
      circulatingSupply: pin.circulatingSupply,
      totalSupply: pin.totalSupply ?? c.totalSupply,
      change24h: pin.change24h ?? c.change24h,
      marketCap:
        pin.marketCap != null && !dogeIsInflated(pin.circulatingSupply)
          ? pin.marketCap
          : price != null && pin.circulatingSupply != null
            ? price * pin.circulatingSupply
            : c.marketCap,
    }
  })
}

function rankCoins(raw: RawCoin[]): MarketCoin[] {
  return raw
    .filter((c) => !EXCLUDED_SYMBOLS.has(c.symbol))
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    .slice(0, TARGET_TOP)
    .map((c, i) => ({ rank: i + 1, ...c }))
}

async function readCmcSnapshot(
  kv: KVLike | null,
  key: string
): Promise<MarketsResponse | null> {
  if (!kv) return null
  try {
    const cached = await kv.get(key)
    if (!cached) return null
    const parsed = JSON.parse(cached) as MarketsResponse
    if (
      parsed.source === "coinmarketcap" &&
      Array.isArray(parsed.coins) &&
      parsed.coins.length > 0
    ) {
      return parsed
    }
  } catch {
    /* ignore corrupt KV */
  }
  return null
}

export async function GET() {
  const kv = await getKV()
  const lastGoodCirc = await readDogeCanonicalCirc(kv)

  // 1) Fresh CMC cache — skip it if DOGE circulating is the 171B
  //    all-mined bug. Better to rebuild than serve a wrong rank.
  const fresh = await readCmcSnapshot(kv, KV_KEY)
  if (fresh && !payloadDogeInflated(fresh)) {
    return NextResponse.json(fresh, {
      headers: { "Cache-Control": "public, max-age=60" },
    })
  }

  // 2) Live CMC listing + CMC DOGE detail + CG (circulating / FDV).
  //    Paprika is NOT in this race.
  const [cmcRaw, dogePin, cgFdvHints] = await Promise.all([
    fetchCoinMarketCap(),
    fetchCmcDogePin(),
    fetchCoinGeckoFdvHints(),
  ])
  const cgDoge = cgFdvHints?.get("DOGE") ?? null
  const canonicalCirc = collectDogeCanonicalCirc(
    cmcRaw,
    dogePin,
    cgDoge,
    lastGoodCirc
  )
  await writeDogeCanonicalCirc(kv, canonicalCirc)

  if (cmcRaw && cmcRaw.length > 0) {
    let raw = applyDogeCanonicalCirc(pinDogeToCmc(cmcRaw, dogePin), canonicalCirc)
    if (cgFdvHints) {
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
    const payload: MarketsResponse = {
      coins: rankCoins(raw),
      fetchedAt: Date.now(),
      source: "coinmarketcap",
      excluded: Array.from(EXCLUDED_SYMBOLS),
    }
    const inflated = payloadDogeInflated(payload)
    if (kv) {
      const json = JSON.stringify(payload)
      try {
        const writes: Array<Promise<void>> = []
        if (!inflated) {
          writes.push(kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }))
          writes.push(kv.put(KV_STALE_KEY, json))
        }
        if (writes.length > 0) await Promise.all(writes)
      } catch {
        /* best-effort */
      }
    }
    if (inflated) {
      const lastGood = await readCmcSnapshot(kv, KV_STALE_KEY)
      if (lastGood && !payloadDogeInflated(lastGood)) {
        return NextResponse.json(
          { ...lastGood, stale: true },
          { headers: { "Cache-Control": "public, max-age=60" } }
        )
      }
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=60" },
    })
  }

  // 3) CMC listing missed. Prefer last-good CMC over paprika. Re-pin
  //    DOGE if the cached row is inflated.
  const lastGood = await readCmcSnapshot(kv, KV_STALE_KEY)
  if (lastGood) {
    const withoutRanks: RawCoin[] = lastGood.coins.map(
      ({ rank: _rank, ...rest }) => rest
    )
    const pinned = applyDogeCanonicalCirc(
      pinDogeToCmc(withoutRanks, dogePin),
      canonicalCirc ?? lastGoodCirc
    )
    const payload: MarketsResponse = {
      ...lastGood,
      coins: rankCoins(pinned),
      fetchedAt: Date.now(),
      source: "coinmarketcap",
    }
    if (kv && !payloadDogeInflated(payload)) {
      try {
        await kv.put(KV_KEY, JSON.stringify(payload), {
          expirationTtl: KV_TTL_SECONDS,
        })
      } catch {
        /* best-effort */
      }
    }
    return NextResponse.json(
      { ...payload, stale: true },
      { headers: { "Cache-Control": "public, max-age=60" } }
    )
  }

  // 4) Cold start with CMC down — paprika so the page isn't blank.
  //    Do NOT write this to KV. Next request retries CMC.
  const paprika = await fetchCoinPaprika()
  if (paprika && paprika.length > 0) {
    const payload: MarketsResponse = {
      coins: rankCoins(
        applyDogeCanonicalCirc(paprika, canonicalCirc ?? lastGoodCirc)
      ),
      fetchedAt: Date.now(),
      source: "coinpaprika",
      excluded: Array.from(EXCLUDED_SYMBOLS),
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=15" },
    })
  }

  return NextResponse.json(
    { error: "All market-data upstreams failed" },
    { status: 502 }
  )
}
