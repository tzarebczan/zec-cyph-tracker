import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD"
const BLOCKCHAIN_MARKET_PRICE =
  "https://api.blockchain.info/charts/market-price?timespan=all&sampled=false&metadata=false&cors=true"
const HISTORY_START_UNIX = 1325376000 // 2012-01-01 UTC
const GENESIS_MS = Date.UTC(2009, 0, 3)
const DAY_MS = 86_400_000
const CACHE_KEY = "bitcoin.rainbow.v2"
const STALE_KEY = "bitcoin.rainbow.stale.v2"
const CACHE_TTL_SECONDS = 3600
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=1800, stale-while-revalidate=86400",
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
  intercept: number
  slope: number
  sigma: number
  rSquared: number
  fitAtNow: number
  sampleCount: number
  sourceStart: string
}

interface BitcoinRainbowResponse {
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
  key: string
): Promise<BitcoinRainbowResponse | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BitcoinRainbowResponse
    if (!parsed.history?.length || !parsed.model || !parsed.latestDaily) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(kv: KVLike | null, payload: BitcoinRainbowResponse) {
  if (!kv) return
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS }),
    kv.put(STALE_KEY, json),
  ]).catch(() => {})
}

function ageDays(timestamp: number): number {
  return Math.max(1, (timestamp - GENESIS_MS) / DAY_MS)
}

function fitPowerLaw(points: PricePoint[], now: number): PowerLawModel {
  const samples = points.filter(
    (point) => point.timestamp >= HISTORY_START_UNIX * 1000 && point.price > 0
  )
  if (samples.length < 365) throw new Error("Insufficient BTC history for model")

  const xs = samples.map((point) => Math.log(ageDays(point.timestamp)))
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
    intercept,
    slope,
    sigma: Math.sqrt(squaredError / Math.max(1, samples.length - 2)),
    rSquared: totalSquares > 0 ? 1 - squaredError / totalSquares : 0,
    fitAtNow: Math.exp(intercept + slope * Math.log(ageDays(now))),
    sampleCount: samples.length,
    sourceStart: new Date(samples[0].timestamp).toISOString().slice(0, 10),
  }
}

function downsampleWeekly(points: PricePoint[]): PricePoint[] {
  const weekly = new Map<number, PricePoint>()
  for (const point of points) {
    const week = Math.floor((point.timestamp - HISTORY_START_UNIX * 1000) / (7 * DAY_MS))
    weekly.set(week, point)
  }
  return [...weekly.values()].sort((a, b) => a.timestamp - b.timestamp)
}

async function fetchBitcoinHistory(): Promise<PricePoint[]> {
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
        point.x >= HISTORY_START_UNIX
          ? [{ timestamp: point.x * 1000, price: point.y }]
          : []
    )
    if (points.length >= 365) return points
    throw new Error("Blockchain.com BTC history was incomplete")
  } catch (error) {
    console.warn("[bitcoin-rainbow] Blockchain.com history failed", error)
  }

  const period2 = Math.floor(Date.now() / 1000) + 86400
  const url =
    `${YAHOO_CHART}?interval=1d&period1=${HISTORY_START_UNIX}` +
    `&period2=${period2}&events=history`
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: CACHE_TTL_SECONDS },
  })
  if (!response.ok) throw new Error(`Yahoo BTC history failed: ${response.status}`)

  const json = await response.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error("Yahoo BTC history returned no result")
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
  if (points.length < 365) throw new Error("Yahoo BTC history was incomplete")
  return points
}

export async function GET() {
  const kv = await getKV()
  const cached = await readCache(kv, CACHE_KEY)
  if (cached) {
    return NextResponse.json(cached, { headers: RESPONSE_HEADERS })
  }

  try {
    const now = Date.now()
    const daily = await fetchBitcoinHistory()
    const payload: BitcoinRainbowResponse = {
      history: downsampleWeekly(daily),
      model: fitPowerLaw(daily, now),
      latestDaily: daily[daily.length - 1],
      fetchedAt: now,
      source:
        daily[0].timestamp < Date.UTC(2013, 0, 1)
          ? "Blockchain.com daily market price"
          : "Yahoo Finance BTC-USD daily close",
    }
    await writeCache(kv, payload)
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (error) {
    console.error("[bitcoin-rainbow] refresh failed", error)
    const stale = await readCache(kv, STALE_KEY)
    if (stale) {
      return NextResponse.json(
        { ...stale, stale: true },
        { headers: RESPONSE_HEADERS }
      )
    }
    return NextResponse.json(
      { error: "Bitcoin power-law history is temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
