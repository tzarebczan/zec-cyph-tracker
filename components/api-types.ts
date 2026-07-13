// Subsets of the existing /api/* responses that the beta UI consumes.
// Kept narrow so SWR caches dedupe cleanly with the legacy components
// using the same keys, and so adding a new field upstream never
// breaks the beta types.

export interface PricesHistoryPoint {
  timestamp: number
  date: string
  cyph: number | null
  btc: number | null
  zec: number
  ratio: number | null
  zecBtcRatio: number | null
}

export interface PricesResponse {
  history: PricesHistoryPoint[]
  current?: {
    cyph: { price: number | null; change24h: number | null }
    zec: { price: number | null; change24h: number | null }
    btc?: { price: number | null; change24h: number | null }
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
      avg3m: number | null
      vsAvg24h: number | null
      vsAvg7d: number | null
      vsAvg30d: number | null
      vsAvg3m: number | null
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
  /** Shares traded during the most recent regular session. */
  regularMarketVolume: number | null
  /** Shares traded during pre-market (if available). */
  preMarketVolume: number | null
  /** Shares traded during after-hours (if available). */
  postMarketVolume: number | null
}

export interface CyphVolumeResponse {
  volume24h: number | null
  volume1w: number | null
  avg7d: number | null
  deltaVs7dAvgPct: number | null
  fetchedAt: number
  error?: string
}

export interface CypherpunkMnavResponse {
  mnav: number | null
  enterpriseValue: number | null
  netAssetValue: number | null
  marketCap: number | null
  fullyDilutedShares: number | null
  zecHoldings: number | null
  source: string
  fetchedAt: number
  stale?: boolean
  message?: string
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
  /** Total on-chain ZEC supply (circulating / mined) from cipherscan's
   *  Zebra node. Optional for back-compat with older cached payloads. */
  chainSupply?: number
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

export interface ShieldingFlowTotals {
  inZec: number
  outZec: number
  netZec: number
  inUsd: number
  outUsd: number
  netUsd: number
  inTx: number
  outTx: number
}

export interface ShieldingBucket extends ShieldingFlowTotals {
  key: string
  label: string
}

export interface ShieldingBlockBucket extends ShieldingFlowTotals {
  block: number
  time: string | null
}

export interface ShieldingTransferOutput {
  recipient: string | null
  valueZec: number
  valueUsd: number | null
}

export interface ShieldingTransfer {
  direction: "in" | "out"
  hash: string
  block: number
  time: string
  amountZec: number
  amountUsd: number | null
  inputCount: number | null
  outputCount: number | null
  recipients: ShieldingTransferOutput[]
  explorerUrl: string
}

export type PostUnshieldStatus =
  | "held"
  | "spent"
  | "reshielded"
  | "reused"
  | "unknown"

export type PostUnshieldReshieldType = "full" | "partial"

export interface PostUnshieldEvent {
  hash: string
  block: number
  time: string
  amountZec: number
  shieldedTouch: boolean
}

export interface PostUnshieldTrace {
  hash: string
  block: number
  time: string
  amountZec: number
  amountUsd: number | null
  address: string
  status: PostUnshieldStatus
  outputSpent: boolean | null
  balanceZec: number | null
  totalReceivedZec: number | null
  totalSentZec: number | null
  txCount: number | null
  lastSeen: string | null
  nextSpend: PostUnshieldEvent | null
  reshield: PostUnshieldEvent | null
  reshieldType: PostUnshieldReshieldType | null
  priorShieldSource: PostUnshieldEvent | null
  explorerUrl: string
  addressUrl: string
}

export interface PostUnshieldSummary {
  traced: number
  held: number
  spent: number
  reshielded: number
  reshieldedFull: number
  reshieldedPartial: number
  reused: number
  unknown: number
  priorShieldSource: number
  tracedZec: number
  heldZec: number
  spentZec: number
  reshieldedZec: number
  reusedZec: number
}

export interface ShieldingDetailsResponse {
  activation: {
    label: string
    block: number
    time: string
    outQuery: string
    inQuery: string
  }
  network: {
    blockHeight: number | null
    bestBlockTime: string | null
    priceUsd: number | null
    hashrate24h: number | null
  }
  totals: {
    sinceActivation: ShieldingFlowTotals
    lastHour: ShieldingFlowTotals
    last24h: ShieldingFlowTotals
    last7d: ShieldingFlowTotals
  }
  series: {
    hourly: ShieldingBucket[]
    daily: ShieldingBucket[]
  }
  blocks: {
    latest: ShieldingBlockBucket[]
    topOut: ShieldingBlockBucket[]
    topNet: ShieldingBlockBucket[]
  }
  recentOut: ShieldingTransfer[]
  recentIn: ShieldingTransfer[]
  counts: {
    outFetched: number
    outTotalRows: number | null
    inFetched: number
    inTotalRows: number | null
    maxRows: number
    truncated: boolean
    rateLimited: boolean
    errors: string[]
    recipientDetails: number
  }
  source: {
    stats: string
    out: string
    in: string
    details: string
  }
  notes: string[]
  fetchedAt: number
  stale?: boolean
}

export type UnshieldingPeriod = "1h" | "12h" | "1d" | "1w" | "1m" | "all"
export type UnshieldingSort = "recent" | "largest"

export interface UnshieldingsResponse {
  activation: {
    label: string
    block: number
    time: string
  }
  pool: "orchard" | "sapling" | "all"
  period: UnshieldingPeriod
  sort: UnshieldingSort
  cutoffTime: string
  fetchedAt: number
  totals: {
    outZec: number
    outUsd: number | null
    outTx: number
  }
  postUnshield: {
    summary: PostUnshieldSummary
    traces: PostUnshieldTrace[]
  }
  analysis: {
    total: number
    analyzed: number
    remaining: number
    complete: boolean
    warming: boolean
    cacheHits: number
    inventoryComplete: boolean
    refreshing: number
  }
  pagination: {
    limit: number
    total: number
    returned: number
    hasNext: boolean
    nextCursor: number | null
    nextCursorId: number | null
    reachedPeriodEnd: boolean
  }
  source: {
    flows: string
    list: string
  }
  notes: string[]
  stale?: boolean
}

export interface OrchardRiskHistoryPoint {
  timestamp: number
  price: number
}

export interface OrchardRiskResponse {
  question: string
  slug: string
  url: string
  description: string
  yesPrice: number | null
  noPrice: number | null
  yesBid: number | null
  yesAsk: number | null
  spread: number | null
  lastTradePrice: number | null
  volume: number | null
  volume24h: number | null
  liquidity: number | null
  openInterest: number | null
  startDate: string | null
  endDate: string | null
  updatedAt: string | null
  fetchedAt: number
  history: OrchardRiskHistoryPoint[]
  source: {
    event: string
    history: string | null
  }
  stale?: boolean
}
