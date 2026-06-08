import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  MarketsResponse,
  PricesResponse,
  ZecStatsResponse,
} from "@/components/api-types"
import { isPositiveNumber } from "@/lib/og-complete"

interface StaticMarketsResponse {
  offshoreWealth: { usd: number; asOf: string; source: string; sourceUrl?: string }
  globalEconomy: { usd: number; asOf: string; source: string; sourceUrl?: string }
  goldSupply: { troyOz: number; asOf: string; source: string; sourceUrl?: string }
  goldPriceFallbackUsd: { value: number; asOf: string; source: string; sourceUrl?: string }
}

interface GoldPriceResponse {
  priceUsd: number
  asOf: string
  source: "live" | "stash" | "static"
  fetchedAt: number
}

interface StablecoinsTotalResponse {
  totalUsd: number
  asOf: string
  asOfDate: string
  source: "defillama" | "stash"
  fetchedAt: number
}

interface WhatIfSnapshotResponse {
  markets: MarketsResponse | null
  zecStats: ZecStatsResponse | null
  pricesTick: PricesResponse | null
  goldPrice: GoldPriceResponse | null
  stablecoinsTotal: StablecoinsTotalResponse | null
  staticMarkets: StaticMarketsResponse
  complete: boolean
  missing: string[]
  fetchedAt: number
  stale?: boolean
}

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (k: string, v: string, o?: { expirationTtl?: number }) => Promise<void>
}

const KV_KEY = "what-if.snapshot.v1"
const KV_TTL_SECONDS = 2 * 60
const KV_STALE_KEY = "what-if.snapshot.stale.v1"

const STATIC_MARKETS_FALLBACK: StaticMarketsResponse = {
  offshoreWealth: { usd: 14.4e12, asOf: "2025-06", source: "fallback" },
  globalEconomy: { usd: 123e12, asOf: "2026-04", source: "fallback" },
  goldSupply: { troyOz: 7.5e9, asOf: "2024-12", source: "fallback" },
  goldPriceFallbackUsd: { value: 4200, asOf: "2026-05", source: "fallback" },
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

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function coin(markets: MarketsResponse | null, symbol: string) {
  return markets?.coins.find((c) => c.symbol === symbol) ?? null
}

function computeStablecoinMcap(markets: MarketsResponse | null): number | null {
  if (!markets) return null
  const stables = ["USDT", "USDC", "DAI", "BUSD", "FDUSD", "USDe", "TUSD"]
  let sum = 0
  let hasUsdt = false
  for (const sym of stables) {
    const marketCoin = coin(markets, sym)
    if (marketCoin?.marketCap != null) {
      sum += marketCoin.marketCap
      if (sym === "USDT") hasUsdt = true
    }
  }
  return hasUsdt ? sum : null
}

function missingFields(s: Omit<WhatIfSnapshotResponse, "complete" | "missing">): string[] {
  const zec = coin(s.markets, "ZEC")
  const btc = coin(s.markets, "BTC")
  const doge = coin(s.markets, "DOGE")
  const zecSupply = s.zecStats?.circulating ?? zec?.circulatingSupply ?? null
  const zecPrice =
    s.pricesTick?.current?.zec?.price ?? s.zecStats?.price ?? zec?.price ?? null
  const stablecoinsUsd =
    s.stablecoinsTotal?.totalUsd ?? computeStablecoinMcap(s.markets)
  const required: Array<[string, unknown]> = [
    ["zecSupply", zecSupply],
    ["zecPrice", zecPrice],
    ["btcMcap", btc?.marketCap],
    ["btcPrice", btc?.price],
    ["dogeMcap", doge?.marketCap],
    ["dogePrice", doge?.price],
    ["goldPrice", s.goldPrice?.priceUsd ?? s.staticMarkets.goldPriceFallbackUsd.value],
    ["goldSupply", s.staticMarkets.goldSupply.troyOz],
    ["offshoreWealth", s.staticMarkets.offshoreWealth.usd],
    ["globalEconomy", s.staticMarkets.globalEconomy.usd],
    ["stablecoins", stablecoinsUsd],
  ]
  return required
    .filter(([, value]) => !isPositiveNumber(value))
    .map(([name]) => name)
}

function parseSnapshot(raw: string): WhatIfSnapshotResponse | null {
  try {
    const parsed = JSON.parse(raw) as WhatIfSnapshotResponse
    if (parsed && parsed.complete && Array.isArray(parsed.markets?.coins)) {
      return parsed
    }
  } catch {
    /* ignore malformed cache */
  }
  return null
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const kv = await getKV()
  const forceRefresh = url.searchParams.get("refresh") === "1"

  if (kv && !forceRefresh) {
    try {
      const cached = await kv.get(KV_KEY)
      const parsed = cached ? parseSnapshot(cached) : null
      if (parsed) {
        return NextResponse.json(parsed, {
          headers: {
            "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
          },
        })
      }
    } catch {
      /* fetch a new snapshot */
    }
  }

  const [
    markets,
    zecStats,
    pricesTick,
    goldPrice,
    stablecoinsTotal,
    staticMarkets,
  ] = await Promise.all([
    fetchJson<MarketsResponse>(`${origin}/api/markets`),
    fetchJson<ZecStatsResponse>(`${origin}/api/zec-stats`),
    fetchJson<PricesResponse>(`${origin}/api/prices?days=7`),
    fetchJson<GoldPriceResponse>(`${origin}/api/gold-price`),
    fetchJson<StablecoinsTotalResponse>(`${origin}/api/stablecoins-total`),
    fetchJson<StaticMarketsResponse>(`${origin}/api/static-markets`),
  ])

  const candidateBase = {
    markets,
    zecStats,
    pricesTick,
    goldPrice,
    stablecoinsTotal,
    staticMarkets: staticMarkets ?? STATIC_MARKETS_FALLBACK,
    fetchedAt: Date.now(),
  }
  const missing = missingFields(candidateBase)
  const candidate: WhatIfSnapshotResponse = {
    ...candidateBase,
    complete: missing.length === 0,
    missing,
  }

  if (candidate.complete && kv) {
    const json = JSON.stringify(candidate)
    try {
      await Promise.all([
        kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
        kv.put(KV_STALE_KEY, json),
      ])
    } catch {
      /* best effort */
    }
  }

  if (!candidate.complete && kv) {
    try {
      const stale = await kv.get(KV_STALE_KEY)
      const parsed = stale ? parseSnapshot(stale) : null
      if (parsed) {
        return NextResponse.json(
          { ...parsed, stale: true },
          { headers: { "Cache-Control": "public, max-age=30" } }
        )
      }
    } catch {
      /* return partial candidate */
    }
  }

  return NextResponse.json(candidate, {
    headers: {
      "Cache-Control": candidate.complete
        ? "public, max-age=30, stale-while-revalidate=120"
        : "no-store, max-age=0",
    },
  })
}
