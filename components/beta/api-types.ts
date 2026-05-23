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
  regularMarketPreviousClose: number | null
  preMarketPrice: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketTime: number | null
  overnightMarketPrice: number | null
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
