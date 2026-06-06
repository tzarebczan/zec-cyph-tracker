import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  OrchardRiskHistoryPoint,
  OrchardRiskResponse,
} from "@/components/api-types"

const SLUG = "zcashs-orchard-pool-confirmed-exploited-20260605210804589"
const POLYMARKET_URL = `https://polymarket.com/event/${SLUG}`
const GAMMA_EVENT_URL = `https://gamma-api.polymarket.com/events/slug/${SLUG}`
const CLOB_HISTORY_URL = "https://clob.polymarket.com/prices-history"
const KV_KEY = "polymarket.orchard-risk.v1"
const KV_STALE_KEY = "polymarket.orchard-risk.stale.v1"
const KV_TTL_SECONDS = 60
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; cyphzec-orchard-risk/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

interface GammaMarket {
  question?: string
  description?: string
  slug?: string
  outcomes?: string[] | string
  outcomePrices?: string[] | string
  clobTokenIds?: string[] | string
  bestBid?: number | string | null
  bestAsk?: number | string | null
  spread?: number | string | null
  lastTradePrice?: number | string | null
  volume?: number | string | null
  volumeNum?: number | string | null
  volume24hr?: number | string | null
  liquidity?: number | string | null
  liquidityNum?: number | string | null
  openInterest?: number | string | null
  startDate?: string | null
  endDate?: string | null
  updatedAt?: string | null
}

interface GammaEvent {
  title?: string
  description?: string
  slug?: string
  volume?: number | string | null
  volume24hr?: number | string | null
  liquidity?: number | string | null
  openInterest?: number | string | null
  startDate?: string | null
  endDate?: string | null
  updatedAt?: string | null
  markets?: GammaMarket[]
}

interface HistoryResponse {
  history?: { t?: number; p?: number }[]
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

function parseArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

function iso(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function outcomePrice(
  market: GammaMarket,
  outcomeName: "Yes" | "No"
): number | null {
  const outcomes = parseArray(market.outcomes)
  const prices = parseArray(market.outcomePrices)
  const index = outcomes.findIndex(
    (outcome) => outcome.toLowerCase() === outcomeName.toLowerCase()
  )
  if (index < 0) return null
  return num(prices[index])
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
  })
  if (!res.ok) {
    throw new Error(`Polymarket upstream ${res.status}`)
  }
  return (await res.json()) as T
}

async function fetchHistory(yesTokenId: string | null) {
  if (!yesTokenId) return { history: [], source: null }
  const url = new URL(CLOB_HISTORY_URL)
  url.searchParams.set("market", yesTokenId)
  url.searchParams.set("interval", "max")
  url.searchParams.set("fidelity", "60")
  const data = await fetchJson<HistoryResponse>(url.toString())
  const history: OrchardRiskHistoryPoint[] = (data.history ?? [])
    .map((point) => ({
      timestamp: num(point.t) ?? NaN,
      price: num(point.p) ?? NaN,
    }))
    .filter(
      (point) =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.price) &&
        point.price >= 0 &&
        point.price <= 1
    )
    .sort((a, b) => a.timestamp - b.timestamp)
  return { history, source: url.toString() }
}

function readCached(raw: string | null): OrchardRiskResponse | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as OrchardRiskResponse
    return typeof parsed.question === "string" ? parsed : null
  } catch {
    return null
  }
}

async function buildPayload(): Promise<OrchardRiskResponse> {
  const event = await fetchJson<GammaEvent>(GAMMA_EVENT_URL)
  const market =
    event.markets?.find((item) => item.slug === SLUG) ?? event.markets?.[0]
  if (!market) {
    throw new Error("Polymarket event returned no market")
  }

  const clobTokenIds = parseArray(market.clobTokenIds)
  const yesTokenId = clobTokenIds[0] ?? null
  let history: OrchardRiskHistoryPoint[] = []
  let historySource: string | null = null
  try {
    const result = await fetchHistory(yesTokenId)
    history = result.history
    historySource = result.source
  } catch {
    history = []
    historySource = null
  }

  return {
    question: market.question ?? event.title ?? "Zcash Orchard exploit?",
    slug: event.slug ?? SLUG,
    url: POLYMARKET_URL,
    description: market.description ?? event.description ?? "",
    yesPrice: outcomePrice(market, "Yes"),
    noPrice: outcomePrice(market, "No"),
    yesBid: num(market.bestBid),
    yesAsk: num(market.bestAsk),
    spread: num(market.spread),
    lastTradePrice: num(market.lastTradePrice),
    volume: num(market.volumeNum) ?? num(market.volume) ?? num(event.volume),
    volume24h: num(market.volume24hr) ?? num(event.volume24hr),
    liquidity:
      num(market.liquidityNum) ?? num(market.liquidity) ?? num(event.liquidity),
    openInterest: num(market.openInterest) ?? num(event.openInterest),
    startDate: iso(market.startDate) ?? iso(event.startDate),
    endDate: iso(market.endDate) ?? iso(event.endDate),
    updatedAt: iso(market.updatedAt) ?? iso(event.updatedAt),
    fetchedAt: Date.now(),
    history,
    source: {
      event: GAMMA_EVENT_URL,
      history: historySource,
    },
  }
}

async function writeKV(kv: KVLike, payload: OrchardRiskResponse) {
  const json = JSON.stringify(payload)
  await Promise.allSettled([
    kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
    kv.put(KV_STALE_KEY, json),
  ])
}

export async function GET() {
  const kv = await getKV()

  if (kv) {
    const cached = readCached(await kv.get(KV_KEY).catch(() => null))
    if (cached) {
      return NextResponse.json(cached, { headers: RESPONSE_HEADERS })
    }
  }

  try {
    const payload = await buildPayload()
    if (kv) {
      writeKV(kv, payload).catch(() => {
        /* best-effort cache write */
      })
    }
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (error) {
    if (kv) {
      const stale = readCached(await kv.get(KV_STALE_KEY).catch(() => null))
      if (stale) {
        return NextResponse.json(
          { ...stale, stale: true },
          { headers: RESPONSE_HEADERS }
        )
      }
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Polymarket market unavailable",
      },
      { status: 502 }
    )
  }
}
