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
    cacheKey: "rainbow.btc.v5",
    staleKey: "rainbow.btc.stale.v5",
  },
  zec: {
    ticker: "ZEC-USD",
    // Fit from Jan 2017, not the Oct 2016 genesis: ZEC's launch weeks saw a
    // multi-thousand-dollar spike that then collapsed ~99%, and including it
    // whipsaws the power-law fit the same way 2009-2011 distorts BTC (hence
    // BTC's 2012 fit start). Age is still measured from genesis via originMs.
    historyStartUnix: 1483228800,
    originMs: Date.UTC(2016, 9, 29),
    cacheKey: "rainbow.zec.v3",
    staleKey: "rainbow.zec.stale.v3",
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
    // Canonical Bitcoin rainbow geometry: nine ~1.35x-per-band steps
    // (0.3 in natural log) with the trend line one and a half bands up
    // from the bottom boundary. Callers may widen `bandWidth` for a more
    // volatile asset.
    bandWidth: 0.3,
    bandOffset: 1.5,
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
    const model = fitPowerLaw(
      daily,
      now,
      config.historyStartUnix,
      config.originMs
    )
    // ZEC is far more volatile than BTC, so the canonical 0.3-ln bands are
    // too tight to contain its dispersion (the price would spend most of its
    // life pinned to the top/bottom band). Widen the bands to roughly the
    // asset's own residual spread while keeping the same rainbow shape and
    // trend positioning as the BTC chart.
    if (asset === "zec") {
      model.bandWidth = Math.min(0.55, Math.max(0.34, model.sigma * 0.62))
    }
    const payload: RainbowResponse = {
      asset,
      history: downsampleWeekly(daily, config.historyStartUnix),
      model,
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
