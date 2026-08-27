import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

type RainbowAsset = "btc" | "zec" | "zecbtc"
type Denomination = "usd" | "btc"
/** Which way the colours run. `classic` is the blockchaincenter reading —
 *  blue/cheap at the bottom, red/expensive at the top — and only makes sense
 *  when the fitted trend RISES, because that is what makes "revert to trend"
 *  a gain for a holder below it. When the trend falls, reverting to it is a
 *  loss, so the reading flips: distance above a decaying trend is strength,
 *  not froth, and the palette is inverted to keep blue/green = good. Chosen
 *  from the fitted slope, never hardcoded. */
type Orientation = "classic" | "inverted"

const BLOCKCHAIN_MARKET_PRICE =
  "https://api.blockchain.info/charts/market-price?timespan=all&sampled=false&metadata=false&cors=true"
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart"
const BITFINEX_CANDLES = "https://api-pub.bitfinex.com/v2/candles/trade:1D"
const DAY_MS = 86_400_000
const CACHE_TTL_SECONDS = 3600
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=1800, stale-while-revalidate=86400",
}

/** Zcash genesis. Both ZEC series are fitted from here, launch spike and all:
 *  the first Bitfinex daily closes are 25 BTC / $3,591, and by mid-December
 *  2016 the price was 0.051 BTC / $40. Excluding those weeks (as this route
 *  used to) throws away the single most informative stretch of the ZEC/BTC
 *  decay — including them lifts that fit from R^2 0.66 to 0.70. */
const ZEC_GENESIS_MS = Date.UTC(2016, 9, 28)
const ZEC_GENESIS_UNIX = ZEC_GENESIS_MS / 1000

interface AssetConfig {
  ticker: string
  historyStartUnix: number
  originMs: number
  denomination: Denomination
  cacheKey: string
  staleKey: string
  /** Bitfinex daily-candle symbol, when that is the primary source. */
  bitfinex?: string
  /** Derive the band geometry from the asset's own residual spread instead
   *  of using the canonical Bitcoin numbers (see `fitBandGeometry`). */
  fitBands: boolean
}

const ASSET_CONFIG: Record<RainbowAsset, AssetConfig> = {
  btc: {
    ticker: "BTC-USD",
    historyStartUnix: 1325376000,
    originMs: Date.UTC(2009, 0, 3),
    denomination: "usd",
    cacheKey: "rainbow.btc.v6",
    staleKey: "rainbow.btc.stale.v6",
    fitBands: false,
  },
  zec: {
    ticker: "ZEC-USD",
    historyStartUnix: ZEC_GENESIS_UNIX,
    originMs: ZEC_GENESIS_MS,
    denomination: "usd",
    cacheKey: "rainbow.zec.v4",
    staleKey: "rainbow.zec.stale.v4",
    bitfinex: "tZECUSD",
    fitBands: true,
  },
  zecbtc: {
    ticker: "ZEC-BTC",
    historyStartUnix: ZEC_GENESIS_UNIX,
    originMs: ZEC_GENESIS_MS,
    denomination: "btc",
    cacheKey: "rainbow.zecbtc.v1",
    staleKey: "rainbow.zecbtc.stale.v1",
    bitfinex: "tZECBTC",
    fitBands: true,
  },
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>
}

interface PricePoint {
  timestamp: number
  price: number
}

interface PowerLawModel {
  mode: "power-law"
  intercept: number
  slope: number
  sigma: number
  rSquared: number
  fitAtNow: number
  sampleCount: number
  sourceStart: string
  originTimestamp: number
  denomination: Denomination
  orientation: Orientation
  // Rainbow bands are fixed-width offsets in natural-log space from the
  // fitted trend line (the blockchaincenter / StephanAkkerman construction),
  // NOT statistical z-score bands. `bandWidth` is the ln-height of one band;
  // `bandOffset` positions the trend line inside the rainbow so the fit sits
  // low (band boundaries run from `-(bandOffset+1)*bandWidth` up to
  // `(8-bandOffset)*bandWidth`).
  bandWidth: number
  bandOffset: number
}

interface RainbowResponse {
  asset: RainbowAsset
  history: PricePoint[]
  model: PowerLawModel
  latestDaily: PricePoint
  fetchedAt: number
  source: string
  stale?: boolean
}

async function getKV(): Promise<KVLike | null> {
  try {
    const context = await getCloudflareContext({ async: true })
    return (
      (context?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
    )
  } catch {
    return null
  }
}

async function readCache(
  kv: KVLike | null,
  key: string,
  asset: RainbowAsset
): Promise<RainbowResponse | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RainbowResponse
    if (
      parsed.asset !== asset ||
      !parsed.history?.length ||
      !parsed.model ||
      !parsed.latestDaily
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeCache(
  kv: KVLike | null,
  config: AssetConfig,
  payload: RainbowResponse
) {
  if (!kv) return
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(config.cacheKey, json, { expirationTtl: CACHE_TTL_SECONDS }),
    kv.put(config.staleKey, json),
  ]).catch(() => {})
}

function ageDays(timestamp: number, originMs: number): number {
  return Math.max(1, (timestamp - originMs) / DAY_MS)
}

/** Size the nine bands to the asset's own residual spread so the whole
 *  history lands inside the rainbow, rather than reusing Bitcoin's canonical
 *  0.3-ln steps. ZEC's dispersion is two to three times Bitcoin's — the fixed
 *  geometry pins it to the top or bottom band for years at a time, which
 *  tells the reader nothing. Returns the ln height of one band plus the
 *  offset that places the trend line at its fitted position inside them. */
function fitBandGeometry(residuals: number[]): {
  bandWidth: number
  bandOffset: number
} {
  const sorted = [...residuals].sort((a, b) => a - b)
  const low = sorted[0]
  const high = sorted[sorted.length - 1]
  // A little headroom so the extremes sit inside the outer bands rather than
  // exactly on their edges, where a rounding step would push them out.
  const pad = (high - low) * 0.04
  const bandWidth = (high - low + 2 * pad) / 9
  return {
    bandWidth,
    // Boundary 0 sits at `-(bandOffset + 1) * bandWidth`; solve for the
    // offset that puts it at the padded minimum residual.
    bandOffset: -(low - pad) / bandWidth - 1,
  }
}

function fitPowerLaw(
  points: PricePoint[],
  now: number,
  config: AssetConfig
): PowerLawModel {
  const { historyStartUnix, originMs } = config
  const samples = points.filter(
    (point) => point.timestamp >= historyStartUnix * 1000 && point.price > 0
  )
  if (samples.length < 365) throw new Error("Insufficient price history for model")

  const xs = samples.map((point) => Math.log(ageDays(point.timestamp, originMs)))
  const ys = samples.map((point) => Math.log(point.price))
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length

  let covariance = 0
  let varianceX = 0
  for (let index = 0; index < xs.length; index += 1) {
    covariance += (xs[index] - meanX) * (ys[index] - meanY)
    varianceX += (xs[index] - meanX) ** 2
  }

  const slope = covariance / varianceX
  const intercept = meanY - slope * meanX
  let squaredError = 0
  let totalSquares = 0
  const residuals: number[] = []
  for (let index = 0; index < xs.length; index += 1) {
    const fitted = intercept + slope * xs[index]
    residuals.push(ys[index] - fitted)
    squaredError += (ys[index] - fitted) ** 2
    totalSquares += (ys[index] - meanY) ** 2
  }

  const geometry = config.fitBands
    ? fitBandGeometry(residuals)
    : // Canonical Bitcoin rainbow geometry: nine ~1.35x-per-band steps
      // (0.3 in natural log) with the trend line one and a half bands up
      // from the bottom boundary.
      { bandWidth: 0.3, bandOffset: 1.5 }

  return {
    mode: "power-law",
    intercept,
    slope,
    sigma: Math.sqrt(squaredError / Math.max(1, samples.length - 2)),
    rSquared: totalSquares > 0 ? 1 - squaredError / totalSquares : 0,
    fitAtNow: Math.exp(intercept + slope * Math.log(ageDays(now, originMs))),
    sampleCount: samples.length,
    sourceStart: new Date(samples[0].timestamp).toISOString().slice(0, 10),
    originTimestamp: originMs,
    denomination: config.denomination,
    orientation: slope < 0 ? "inverted" : "classic",
    ...geometry,
  }
}

function downsampleWeekly(
  points: PricePoint[],
  historyStartUnix: number
): PricePoint[] {
  const weekly = new Map<number, PricePoint>()
  for (const point of points) {
    const week = Math.floor(
      (point.timestamp - historyStartUnix * 1000) / (7 * DAY_MS)
    )
    weekly.set(week, point)
  }
  return [...weekly.values()].sort((a, b) => a.timestamp - b.timestamp)
}

async function fetchBitcoinHistory(): Promise<PricePoint[]> {
  const config = ASSET_CONFIG.btc
  try {
    const response = await fetch(BLOCKCHAIN_MARKET_PRICE, {
      next: { revalidate: CACHE_TTL_SECONDS },
    })
    if (!response.ok) {
      throw new Error(`Blockchain.com BTC history failed: ${response.status}`)
    }
    const json = await response.json()
    const points: PricePoint[] = (json?.values ?? []).flatMap(
      (point: { x?: number; y?: number }) =>
        point.x != null &&
        point.y != null &&
        Number.isFinite(point.y) &&
        point.y > 0 &&
        point.x >= config.historyStartUnix
          ? [{ timestamp: point.x * 1000, price: point.y }]
          : []
    )
    if (points.length >= 365) return points
    throw new Error("Blockchain.com BTC history was incomplete")
  } catch (error) {
    console.warn("[rainbow] Blockchain.com BTC history failed", error)
    return fetchYahooHistory(config)
  }
}

/** Bitfinex has listed ZEC since launch day and serves the whole daily series
 *  in one unauthenticated call, which no other free source does: Yahoo's
 *  ZEC-USD starts 2017-11-09, and CoinGecko / CryptoCompare / CoinPaprika all
 *  now gate deep history behind a key. Rows are
 *  `[timestamp, open, close, high, low, volume]`. */
async function fetchBitfinexHistory(symbol: string): Promise<PricePoint[]> {
  const response = await fetch(
    `${BITFINEX_CANDLES}:${symbol}/hist?limit=10000&sort=1`,
    {
      headers: { Accept: "application/json" },
      next: { revalidate: CACHE_TTL_SECONDS },
    }
  )
  if (!response.ok) {
    throw new Error(`Bitfinex ${symbol} history failed: ${response.status}`)
  }
  const rows = await response.json()
  if (!Array.isArray(rows)) throw new Error(`Bitfinex ${symbol} returned no rows`)
  const points: PricePoint[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const timestamp = Number(row[0])
    const close = Number(row[2])
    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) {
      continue
    }
    points.push({ timestamp, price: close })
  }
  if (points.length < 365) throw new Error(`Bitfinex ${symbol} was incomplete`)
  return points.sort((a, b) => a.timestamp - b.timestamp)
}

async function fetchYahooHistory(config: AssetConfig): Promise<PricePoint[]> {
  const period2 = Math.floor(Date.now() / 1000) + 86400
  const url =
    `${YAHOO_CHART}/${config.ticker}?interval=1d&period1=${config.historyStartUnix}` +
    `&period2=${period2}&events=history`
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: CACHE_TTL_SECONDS },
  })
  if (!response.ok) {
    throw new Error(`Yahoo ${config.ticker} history failed: ${response.status}`)
  }

  const json = await response.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`Yahoo ${config.ticker} returned no result`)
  const timestamps: number[] = result.timestamp ?? []
  const closes: (number | null)[] =
    result.indicators?.adjclose?.[0]?.adjclose ??
    result.indicators?.quote?.[0]?.close ??
    []
  const points: PricePoint[] = []
  for (let index = 0; index < timestamps.length; index += 1) {
    const price = closes[index]
    if (price == null || !Number.isFinite(price) || price <= 0) continue
    points.push({ timestamp: timestamps[index] * 1000, price })
  }
  if (points.length < 365) throw new Error(`Yahoo ${config.ticker} was incomplete`)
  return points
}

/** Yahoo lists no ZEC-BTC pair, so the fallback divides the two USD series
 *  day by day. It starts in November 2017 rather than at genesis, which is
 *  exactly the history this chart exists to show — hence a fallback, used
 *  only when Bitfinex is unreachable, and never in preference to it. */
async function fetchYahooRatioHistory(): Promise<PricePoint[]> {
  const [zec, btc] = await Promise.all([
    fetchYahooHistory({ ...ASSET_CONFIG.zec, ticker: "ZEC-USD" }),
    fetchYahooHistory({ ...ASSET_CONFIG.zec, ticker: "BTC-USD" }),
  ])
  const btcByDay = new Map<string, number>()
  for (const point of btc) {
    btcByDay.set(new Date(point.timestamp).toISOString().slice(0, 10), point.price)
  }
  const points: PricePoint[] = []
  for (const point of zec) {
    const day = btcByDay.get(new Date(point.timestamp).toISOString().slice(0, 10))
    if (day == null || day <= 0) continue
    points.push({ timestamp: point.timestamp, price: point.price / day })
  }
  if (points.length < 365) throw new Error("Yahoo ZEC/BTC ratio was incomplete")
  return points
}

async function fetchHistory(
  asset: RainbowAsset,
  config: AssetConfig
): Promise<{ points: PricePoint[]; source: string }> {
  if (asset === "btc") {
    const points = await fetchBitcoinHistory()
    return {
      points,
      source:
        points[0].timestamp < Date.UTC(2013, 0, 1)
          ? "Blockchain.com daily market price"
          : `Yahoo Finance ${config.ticker} daily close`,
    }
  }
  try {
    return {
      points: await fetchBitfinexHistory(config.bitfinex as string),
      source: `Bitfinex ${config.bitfinex} daily close, from launch`,
    }
  } catch (error) {
    console.warn(`[rainbow] Bitfinex ${config.bitfinex} failed`, error)
    if (asset === "zecbtc") {
      return {
        points: await fetchYahooRatioHistory(),
        source: "Yahoo Finance ZEC-USD / BTC-USD daily close",
      }
    }
    return {
      points: await fetchYahooHistory(config),
      source: `Yahoo Finance ${config.ticker} daily close`,
    }
  }
}

function parseAsset(value: string | null): RainbowAsset {
  if (value === "zec") return "zec"
  if (value === "zecbtc" || value === "zec-btc") return "zecbtc"
  return "btc"
}

export async function GET(request: Request) {
  const asset = parseAsset(new URL(request.url).searchParams.get("asset"))
  const config = ASSET_CONFIG[asset]
  const kv = await getKV()
  const cached = await readCache(kv, config.cacheKey, asset)
  if (cached) return NextResponse.json(cached, { headers: RESPONSE_HEADERS })

  try {
    const now = Date.now()
    const { points, source } = await fetchHistory(asset, config)
    const payload: RainbowResponse = {
      asset,
      history: downsampleWeekly(points, config.historyStartUnix),
      model: fitPowerLaw(points, now, config),
      latestDaily: points[points.length - 1],
      fetchedAt: now,
      source,
    }
    await writeCache(kv, config, payload)
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (error) {
    console.error(`[rainbow] ${asset} refresh failed`, error)
    const stale = await readCache(kv, config.staleKey, asset)
    if (stale) {
      return NextResponse.json(
        { ...stale, stale: true },
        { headers: RESPONSE_HEADERS }
      )
    }
    return NextResponse.json(
      { error: `${asset.toUpperCase()} power-law history is temporarily unavailable` },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
