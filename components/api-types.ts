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

export interface PriceRatioStats {
  avg24h: number | null
  avg7d: number | null
  avg30d: number | null
  avg3m: number | null
  vsAvg24h: number | null
  vsAvg7d: number | null
  vsAvg30d: number | null
  vsAvg3m: number | null
  // Optional for compatibility with price payloads cached before ratio
  // window changes and ZEC/BTC statistics were added.
  change24h?: number | null
  change7d?: number | null
  change30d?: number | null
  change90d?: number | null
}

export interface PricesResponse {
  /** Set when the route served its no-TTL stale mirror after an upstream
   *  failure. That entry never expires, so a consumer with a fresher
   *  alternative source should prefer the alternative. */
  stale?: boolean
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
    ratio: PriceRatioStats
    zecBtcRatio?: PriceRatioStats
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
  ironwood: number
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
  /** Disclosed mining capital deployment. Null until cypherpunk reports one.
   *  They publish a dollar amount and a date only — no ZEC-mined figure. */
  mining: {
    investedUSD: number
    startedAt: string
    outlays: number
  } | null
  /** Total non-ZEC investment at cost (mining plus other stakes). */
  investmentsAtCost: number | null
  fetchedAt: number
}

/** A single ZEC trading pair on a single exchange, normalised across
 *  upstreams. Powers both the at-a-glance "TOP MARKETS" strip on the dashboard
 *  and the full `/stats` exchanges treemap. */
export interface ZecMarketTicker {
  /** Display name of the exchange (e.g. "Binance", "Coinbase Exchange"). */
  exchange: string
  /** CoinGecko's stable identifier for the exchange, used as a stable key. */
  exchangeId: string
  /** Optional exchange logo URL — CG returns one for most major exchanges. */
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
  /** Share of the total ZEC volume across all tracked exchanges, [0, 1]. */
  volumeShare: number
  /** CoinGecko's confidence rating: "green" | "yellow" | "red" | null.
   *  Surfaced so the heat-map can dim untrusted exchanges without removing
   *  them entirely. */
  trustScore: string | null
  /** Spread between bid + ask, percent (CG's `bid_ask_spread_percentage`). */
  bidAskSpread: number | null
  /** Hyperlink to the trading pair on the exchange's site (CG's
   *  `trade_url`). */
  tradeUrl: string | null
}

/** Aggregation across all pairs hosted by a single exchange. */
export interface ZecExchangeAgg {
  exchange: string
  exchangeId: string
  exchangeLogo: string | null
  /** Sum of all pair volumes (USD) hosted by this exchange. */
  volumeUsd24h: number
  /** Share of the total ZEC volume (across all exchanges), [0, 1]. */
  share: number
  /** Number of distinct ZEC pairs the exchange lists. */
  marketCount: number
  /** Worst trust score across this exchange's ZEC pairs, lowercased. */
  trustScore: string | null
  /** Percent change of this exchange's 24h-rolling volume vs the
   *  reference snapshot picked from the rolling KV ring. Picked entry
   *  is the one closest to T-24h within ±2h when steady state; during
   *  warm-up (first day after deploy) we fall back to the OLDEST
   *  snapshot in the ring, so this field can read e.g. "+8% vs 4h
   *  ago" before settling on a true "vs prev day" compare. The actual
   *  window the change was computed over is in
   *  `volumeChangeWindowHours`. `null` when no reference snapshot is
   *  available (very first fetch on an empty ring) or when the exchange
   *  wasn't in the reference snapshot. */
  volumeChange24h: number | null
  /** Hours of history the change was computed over. ~24 in steady
   *  state; smaller during the first ~24h after deploy. UI uses this
   *  to label tooltips honestly ("vs 4h ago" rather than misleading
   *  "vs prev day"). null whenever volumeChange24h is null. */
  volumeChangeWindowHours: number | null
}

/** Aggregation across all exchanges for a single trading pair. */
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
  /** Distinct exchange count. */
  exchangeCount: number
  /** All pairs, sorted by `volumeUsd24h` descending. */
  markets: ZecMarketTicker[]
  /** Per-exchange aggregations, sorted by `volumeUsd24h` descending. */
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
  pool: "ironwood" | "orchard" | "sapling" | "all"
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

// ---------------------------------------------------------------------------
// /api/zec-depth — aggregated order-book depth, trade tape and intraday
// microstructure. Mirrors the wire shape built in app/api/zec-depth/route.ts;
// see that file's header for how the exchange books are stitched together.
// ---------------------------------------------------------------------------

export interface DepthBin {
  /** Outer edge of the bin, in bps from the consensus mid. */
  bps: number
  bidUsd: number
  askUsd: number
  bidCumUsd: number
  askCumUsd: number
}

export interface DepthLadderRow {
  bps: number
  bidUsd: number
  askUsd: number
  bidZec: number
  askZec: number
  /** (bid - ask) / (bid + ask) inside this distance. Positive = bid-heavy. */
  imbalance: number | null
}

export interface DepthWall {
  side: "bid" | "ask"
  price: number
  usd: number
  zec: number
  bps: number
  exchanges: number
}

export interface DepthImpactRow {
  usd: number
  buyBps: number | null
  sellBps: number | null
  buyPrice: number | null
  sellPrice: number | null
}

export interface DepthMarket {
  /** e.g. "ZEC/USDC". */
  pair: string
  ok: boolean
  carried: boolean
  ageMs: number
  fallback: boolean
  error: string | null
  /** Resting within ±1% of this market's mid, converted to dollars. */
  depthUsd: number
  spreadBps: number | null
  /** This market's mid against the consensus mid, in bps. For a non-USD
   *  quote this includes the exchange rate, which is why a EUR or BTC book
   *  can show a basis far larger than any USD book's. */
  basisBps: number | null
  levels: number
}

export interface DepthExchange {
  id: string
  name: string
  pair: string
  /** Whether we have a usable book at all — live or carried. */
  ok: boolean
  /** True when this exchange failed to refresh and its last good book is
   *  being carried forward. Depth still counts; touch and basis are `ageMs`
   *  old. */
  carried: boolean
  /** Age of the book in ms. Zero for a live fetch. */
  ageMs: number
  /** True when the primary host failed and a fallback host answered. */
  fallback: boolean
  /** Set whenever the live fetch failed, including when a book was carried. */
  error: string | null
  mid: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number | null
  bidUsd: number
  askUsd: number
  depthUsd: number
  share: number
  /** Exchange mid vs consensus mid, in bps. Positive = trading rich. */
  basisBps: number | null
  /** Summed across this exchange's markets. */
  levels: number
  /** Every ZEC market we read on this exchange, so a row that is up on its
   *  main book but down on a thin pair can say so. */
  markets: DepthMarket[]
}

export interface TapeWindow {
  minutes: number
  buyUsd: number
  sellUsd: number
  deltaUsd: number
  /** buyUsd / (buyUsd + sellUsd), or null when the window saw no volume. */
  pressure: number | null
  trades: number
  /** Exchange names actually summed for this window. */
  exchanges: string[]
  /** How many live tape exchanges had trade history reaching back the whole
   *  window. Fewer than `exchangesLive` means the totals under-state real
   *  flow; zero means not even the summed exchanges had the full window. */
  covered: number
  /** Live tape exchanges in this snapshot, whether or not they covered. */
  exchangesLive: number
}

export interface TapePrint {
  id: string
  ts: number
  side: "buy" | "sell"
  usd: number
  price: number
  zec: number
  exchange: string
}

export interface CvdPoint {
  ts: number
  cum: number
}

export interface DepthMicroStats {
  price: number | null
  high24h: number | null
  low24h: number | null
  rangePct24h: number | null
  vwap24h: number | null
  vwapPremiumBps: number | null
  vol24hPct: number | null
  vol7dPct: number | null
  vol30dPct: number | null
  atr24hPct: number | null
  volumeZec24h: number | null
  high7d: number | null
  low7d: number | null
  high30d: number | null
  low30d: number | null
  trend: {
    m5: number | null
    m15: number | null
    h1: number | null
    h4: number | null
    h24: number | null
  }
  candles: {
    startTs: number
    endTs: number
    stepMs: number
    closes: number[]
  } | null
}

export interface ZecDepthResponse {
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
    /** Notional floor a trade had to clear to appear in `prints`. */
    minPrintUsd: number
    /** How far back `prints` looks. */
    printWindowMinutes: number
  }
  micro: DepthMicroStats | null
  totals: { bidUsd: number; askUsd: number }
  maxBps: number
  /** How far out the market-impact walk was allowed to fill, in bps. */
  impactMaxBps: number
  /** Exchanges contributing a book, live or carried. */
  exchangesOk: number
  /** Of those, how many answered this poll. */
  exchangesLive: number
  exchangesTotal: number
  /** Individual order books contributing, across all exchanges. An exchange
   *  usually hosts more than one ZEC market. */
  marketsOk: number
  marketsTotal: number
  fetchedAt: number
  stale?: boolean
}
