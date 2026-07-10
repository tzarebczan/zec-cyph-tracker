import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

type RainbowAsset = "btc" | "zec"

const BLOCKCHAIN_MARKET_PRICE =
  "https://api.blockchain.info/charts/market-price?timespan=all&sampled=false&metadata=false&cors=true"
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart"
const DAY_MS = 86_400_000
const CACHE_TTL_SECONDS = 3600
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=1800, stale-while-revalidate=86400",
}

const ASSET_CONFIG: Record<
  RainbowAsset,
  {
    ticker: string
    historyStartUnix: number
    originMs: number
    cacheKey: string
    staleKey: string
  }
> = {
  btc: {
    ticker: "BTC-USD",
    historyStartUnix: 1325376000,
    originMs: Date.UTC(2009, 0, 3),
    cacheKey: "rainbow.btc.v4",
    staleKey: "rainbow.btc.stale.v4",
  },
  zec: {
    ticker: "ZEC-USD",
    historyStartUnix: 1477699200,
    originMs: Date.UTC(2016, 9, 29),
    cacheKey: "rainbow.zec.v2",
    staleKey: "rainbow.zec.stale.v2",
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
  mode: "power-law" | "adaptive-log"
  intercept: number
  slope: number
  sigma: number
  rSquared: number
  fitAtNow: number
  sampleCount: number
  sourceStart: string
  originTimestamp: number
  bandMinZ: number
  bandMaxZ: number
  halfLifeDays?: number
  calibrationWindowDays?: number
}

interface RainbowResponse {
  asset: RainbowAsset
  history: PricePoint[]
  trendHistory?: PricePoint[]
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
  config: (typeof ASSET_CONFIG)[RainbowAsset],
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

function fitPowerLaw(
  points: PricePoint[],
  now: number,
  historyStartUnix: number,
  originMs: number
): PowerLawModel {
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
  for (let index = 0; index < xs.length; index += 1) {
    const fitted = intercept + slope * xs[index]
    squaredError += (ys[index] - fitted) ** 2
    totalSquares += (ys[index] - meanY) ** 2
  }

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
    bandMinZ: -2.25,
    bandMaxZ: 2.25,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function fitAdaptiveLogTrend(
  points: PricePoint[],
  historyStartUnix: number,
  originMs: number
): { model: PowerLawModel; trend: PricePoint[] } {
  const samples = points.filter(
    (point) => point.timestamp >= historyStartUnix * 1000 && point.price > 0
  )
  if (samples.length < 365) {
    throw new Error("Insufficient ZEC history for adaptive model")
  }

  const halfLifeDays = 180
  const calibrationWindowDays = 4 * 365
  let logTrend = Math.log(samples[0].price)
  let previousTimestamp = samples[0].timestamp
  const trend: PricePoint[] = []
  const residuals: { timestamp: number; value: number }[] = []

  for (const point of samples) {
    const elapsedDays = Math.max(
      0.25,
      (point.timestamp - previousTimestamp) / DAY_MS
    )
    const alpha = 1 - Math.exp((Math.log(0.5) * elapsedDays) / halfLifeDays)
    const logPrice = Math.log(point.price)
    logTrend += alpha * (logPrice - logTrend)
    trend.push({ timestamp: point.timestamp, price: Math.exp(logTrend) })
    residuals.push({ timestamp: point.timestamp, value: logPrice - logTrend })
    previousTimestamp = point.timestamp
  }

  const latestTimestamp = samples[samples.length - 1].timestamp
  const calibrated = residuals
    .filter(
      (entry) =>
        entry.timestamp >= latestTimestamp - calibrationWindowDays * DAY_MS
    )
    .map((entry) => entry.value)
  const residualMedian = median(calibrated)
  const mad = median(
    calibrated.map((value) => Math.abs(value - residualMedian))
  )
  const sigma = Math.max(0.1, mad * 1.4826)
  const logPrices = samples.map((point) => Math.log(point.price))
  const meanLogPrice =
    logPrices.reduce((sum, value) => sum + value, 0) / logPrices.length
  const squaredError = residuals.reduce(
    (sum, entry) => sum + entry.value ** 2,
    0
  )
  const totalSquares = logPrices.reduce(
    (sum, value) => sum + (value - meanLogPrice) ** 2,
    0
  )
  const fitAtNow = trend[trend.length - 1].price

  return {
    model: {
      mode: "adaptive-log",
      intercept: Math.log(fitAtNow),
      slope: 0,
      sigma,
      rSquared: totalSquares > 0 ? 1 - squaredError / totalSquares : 0,
      fitAtNow,
      sampleCount: samples.length,
      sourceStart: new Date(samples[0].timestamp).toISOString().slice(0, 10),
      originTimestamp: originMs,
      bandMinZ: -3,
      bandMaxZ: 3,
      halfLifeDays,
      calibrationWindowDays,
    },
    trend,
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

async function fetchYahooHistory(
  config: (typeof ASSET_CONFIG)[RainbowAsset]
): Promise<PricePoint[]> {
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

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("asset")
  const asset: RainbowAsset = requested === "zec" ? "zec" : "btc"
  const config = ASSET_CONFIG[asset]
  const kv = await getKV()
  const cached = await readCache(kv, config.cacheKey, asset)
  if (cached) return NextResponse.json(cached, { headers: RESPONSE_HEADERS })

  try {
    const now = Date.now()
    const daily =
      asset === "btc" ? await fetchBitcoinHistory() : await fetchYahooHistory(config)
    const adaptive =
      asset === "zec"
        ? fitAdaptiveLogTrend(
            daily,
            config.historyStartUnix,
            config.originMs
          )
        : null
    const payload: RainbowResponse = {
      asset,
      history: downsampleWeekly(daily, config.historyStartUnix),
      trendHistory: adaptive
        ? downsampleWeekly(adaptive.trend, config.historyStartUnix)
        : undefined,
      model:
        adaptive?.model ??
        fitPowerLaw(
          daily,
          now,
          config.historyStartUnix,
          config.originMs
        ),
      latestDaily: daily[daily.length - 1],
      fetchedAt: now,
      source:
        asset === "btc" && daily[0].timestamp < Date.UTC(2013, 0, 1)
          ? "Blockchain.com daily market price"
          : `Yahoo Finance ${config.ticker} daily close`,
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
