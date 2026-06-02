// Subsets of the existing /api/* responses that the beta UI consumes.
// Kept narrow so SWR caches dedupe cleanly with the legacy components
// using the same keys, and so adding a new field upstream never
// breaks the beta types.

export interface PricesHistoryPoint {
  timestamp: number
  date: string
  cyph: number
  zec: number
  ratio: number | null
}

export interface PricesResponse {
  history: PricesHistoryPoint[]
  current?: {
    cyph: { price: number | null; change24h: number | null }
    zec: { price: number | null; change24h: number | null }
  }
  stats?: {
    cyph: {
      change24h: number | null
      change7d: number | null
      change30d: number | null
      change90d: number | null
    }
    zec: {
      change24h: number | null
      change7d: number | null
      change30d: number | null
      change90d: number | null
    }
    ratio: {
      avg24h: number | null
      avg7d: number | null
      avg30d: number | null
      vsAvg24h: number | null
      vsAvg7d: number | null
      vsAvg30d: number | null
    }
  }
}

export interface QuoteSnapshot {
  marketState: string
  regularMarketPrice: number | null
  /** Absolute $ change of the regular session vs the prior close.
   *  Used by the dashboard's "Today (regular)" line so users see
   *  the real intraday move regardless of which extended-hours
   *  session is currently driving the headline price. */
  regularMarketChange: number | null
  regularMarketChangePercent: number | null
  regularMarketPreviousClose: number | null
  /** Unix seconds of the most recent regular-session tick. Surfaced
   *  so the dashboard can detect "Yahoo says REGULAR but no trading
   *  is actually happening" days (US market holidays like Memorial
   *  Day or Thanksgiving, where Yahoo's marketState is on the wrong
   *  side of the calendar). */
  regularMarketTime: number | null
  preMarketPrice: number | null
  /** Yahoo's `preMarketChange` is `preMarketPrice - regularMarketPreviousClose`.
   *  Surfacing it lets the dashboard render an "AFT/PRE/OVN +$X.XX"
   *  delta line whenever the headline is sourced from extended hours,
   *  without having to re-derive the math client-side. */
  preMarketChange: number | null
  preMarketChangePercent: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketChange: number | null
  postMarketChangePercent: number | null
  postMarketTime: number | null
  overnightMarketPrice: number | null
  overnightMarketChange: number | null
  overnightMarketChangePercent: number | null
  overnightMarketTime: number | null
  sharesOutstanding: number | null
  marketCap: number | null
}

export interface MarketCoin {
  rank: number
  symbol: string
  name: string
  marketCap: number | null
  fdv?: number | null
  circulatingSupply: number | null
  price?: number | null
  change24h?: number | null
  /** Coin logo URL (CoinMarketCap or CoinPaprika depending on which
   *  upstream the /api/markets route served from). May be null when the
   *  upstream omitted an id; the `CoinLogo` primitive handles missing
   *  URLs + 404s with a monogram fallback. */
  image?: string | null
}

export interface MarketsResponse {
  coins: MarketCoin[]
}

export interface ShieldedBreakdown {
  total: number
  sprout: number
  sapling: number
  orchard: number
  lockbox: number
  transparent: number
  pct: number
  source: string
}

export interface ZecStatsResponse {
  rank: number | null
  marketCap: number | null
  price: number | null
  change24h: number | null
  mcapChange24h: number | null
  mcapChange7d: number | null
  mcapChange30d: number | null
  mcapSeries: [number, number][]
  volume24h: number | null
  volumeSeries: [number, number][]
  circulating: number | null
  total: number | null
  max: number
  ath: number | null
  athChangePct: number | null
  shielded: number | null
  shieldedPct: number | null
  shieldedBreakdown: ShieldedBreakdown | null
  shieldedSource: string | null
  fetchedAt: number
  stale?: boolean
}

export interface HoldingsTx {
  id: string
  date: string
  type: "buy" | "sell"
  assetSymbol: string
  assetName: string
  amount: number | null
  unitPrice: number | null
  totalValue: number | null
}

export interface HoldingsResponse {
  transactions: HoldingsTx[]
  summary: {
    totalZec: number
    totalCostUSD: number
    avgCostPerZec: number | null
    transactionCount: number
    buyCount: number
    sellCount: number
    firstTransactionAt: string | null
    lastTransactionAt: string | null
  }
  supply: {
    circulating: number | null
    max: number
    pctOfCirculating: number | null
    pctOfMax: number | null
    targetPct: number
    progressTowardTarget: number | null
  }
  fetchedAt: number
}

/** A single ZEC trading pair on a single venue, normalised across upstreams.
 *  Powers both the at-a-glance "TOP MARKETS" strip on the dashboard and the
 *  full `/stats` exchanges treemap. */
export interface ZecMarketTicker {
  /** Display name of the venue (e.g. "Binance", "Coinbase Exchange"). */
  exchange: string
  /** CoinGecko's stable identifier for the venue, used as a stable key. */
  exchangeId: string
  /** Optional venue logo URL — CG returns one for most major exchanges. */
  exchangeLogo: string | null
  /** Base / target asset symbols (e.g. ZEC / USDT). */
  base: string
  target: string
  /** Concatenated `BASE/TARGET` for display. */
  pair: string
  /** Last reported trade price in USD (CoinGecko's `converted_last.usd`). */
  lastPriceUsd: number | null
  /** 24h volume converted to USD. */
  volumeUsd24h: number | null
  /** Share of the total ZEC volume across all tracked venues, [0, 1]. */
  volumeShare: number
  /** CoinGecko's confidence rating: "green" | "yellow" | "red" | null.
   *  Surfaced so the heat-map can dim untrusted venues without removing
   *  them entirely. */
  trustScore: string | null
  /** Spread between bid + ask, percent (CG's `bid_ask_spread_percentage`). */
  bidAskSpread: number | null
  /** Hyperlink to the trading pair on the venue's site (CG's `trade_url`). */
  tradeUrl: string | null
}

/** Aggregation across all pairs hosted by a single venue. */
export interface ZecExchangeAgg {
  exchange: string
  exchangeId: string
  exchangeLogo: string | null
  /** Sum of all pair volumes (USD) hosted by this venue. */
  volumeUsd24h: number
  /** Share of the total ZEC volume (across all venues), [0, 1]. */
  share: number
  /** Number of distinct ZEC pairs the venue lists. */
  marketCount: number
  /** Worst trust score across this venue's ZEC pairs, lowercased. */
  trustScore: string | null
  /** Percent change of this venue's 24h-rolling volume vs the
   *  reference snapshot picked from the rolling KV ring. Picked entry
   *  is the one closest to T-24h within ±2h when steady state; during
   *  warm-up (first day after deploy) we fall back to the OLDEST
   *  snapshot in the ring, so this field can read e.g. "+8% vs 4h
   *  ago" before settling on a true "vs prev day" compare. The actual
   *  window the change was computed over is in
   *  `volumeChangeWindowHours`. `null` when no reference snapshot is
   *  available (very first fetch on an empty ring) or when the venue
   *  wasn't in the reference snapshot. */
  volumeChange24h: number | null
  /** Hours of history the change was computed over. ~24 in steady
   *  state; smaller during the first ~24h after deploy. UI uses this
   *  to label tooltips honestly ("vs 4h ago" rather than misleading
   *  "vs prev day"). null whenever volumeChange24h is null. */
  volumeChangeWindowHours: number | null
}

/** Aggregation across all venues for a single trading pair. */
export interface ZecPairAgg {
  pair: string
  volumeUsd24h: number
  share: number
  marketCount: number
}

export interface ZecExchangesResponse {
  /** Sum of `volumeUsd24h` across every tracked pair. */
  total24hVolumeUsd: number
  /** Total number of distinct pairs tracked. */
  marketCount: number
  /** Distinct venue count. */
  exchangeCount: number
  /** All pairs, sorted by `volumeUsd24h` descending. */
  markets: ZecMarketTicker[]
  /** Per-venue aggregations, sorted by `volumeUsd24h` descending. */
  byExchange: ZecExchangeAgg[]
  /** Per-pair aggregations (ZEC/USDT, ZEC/USD, ...) sorted descending. */
  byPair: ZecPairAgg[]
  /** "coingecko" | "stale" — which path served this payload. */
  source: string
  fetchedAt: number
  /** True when the long-lived stale mirror was served because the
   *  upstream call failed. */
  stale?: boolean
}
