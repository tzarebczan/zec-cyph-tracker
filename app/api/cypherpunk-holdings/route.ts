import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Proxies cypherpunk.com's public Payload-CMS transactions endpoint and
// computes the aggregates we want to show (total ZEC held, total cost
// basis, average cost per ZEC, last transaction date). The upstream lives
// at https://cypherpunk.com/api/transactions and is JSON, so no scraping
// or HTML parsing — we just fetch + reshape.
//
// We also surface ZEC circulating supply (from CoinGecko, with CoinPaprika
// as fallback) so the UI can show "% of circulating supply held" against
// CYPH's stated 5% circulating-supply acquisition target. Supply is cached in
// Workers KV for 24h since it ticks once per day at most — keeps us well clear
// of CoinGecko's free 30-req/min limit even at high traffic.

const TRANSACTIONS_URL = "https://cypherpunk.com/api/transactions?limit=200"
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/zcash?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false"
const COINPAPRIKA_URL = "https://api.coinpaprika.com/v1/coins/zec-zcash"

const SUPPLY_KV_KEY = "zec.circulating_supply.v1"
const SUPPLY_TTL_SECONDS = 24 * 3600 // 24h — supply changes once per day at most

// CYPH's stated treasury accumulation target (5% of total ZEC supply).
// Hard-coded for now — if Cypherpunk ever publishes this in their CMS we
// can read it from there.
const TARGET_PCT_OF_SUPPLY = 5

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface UpstreamTx {
  id?: string
  date?: string
  type?: "buy" | "sell" | string
  asset?: { name?: string; symbol?: string; website?: string | null }
  amount?: number | null
  unitPrice?: number | null
  totalValue?: number | null
  fees?: number | null
  source?: string | null
  notes?: string | null
}

interface UpstreamResponse {
  docs?: UpstreamTx[]
  totalDocs?: number
}

interface NormalizedTx {
  id: string
  date: string
  type: "buy" | "sell"
  assetSymbol: string
  assetName: string
  amount: number | null
  unitPrice: number | null
  totalValue: number | null
}

interface Summary {
  totalZec: number
  totalCostUSD: number
  avgCostPerZec: number | null
  transactionCount: number
  buyCount: number
  sellCount: number
  firstTransactionAt: string | null
  lastTransactionAt: string | null
}

interface SupplyInfo {
  /** Current ZEC circulating supply in coins (CoinGecko's market_data). */
  circulating: number | null
  /** ZEC max supply per protocol (21M, hard cap). */
  max: number
  /** % of circulating ZEC held by CYPH right now. */
  pctOfCirculating: number | null
  /** % of max supply held — for the more conservative read. */
  pctOfMax: number | null
  /** CYPH's publicly-stated acquisition target as % of circulating supply. */
  targetPct: number
  /** How far along we are toward the target, expressed as a 0-1 fraction
   *  of pctOfCirculating / targetPct. Capped at 1 server-side
   *  so the UI doesn't have to think about over-target rendering. */
  progressTowardTarget: number | null
}

function normalize(docs: UpstreamTx[]): NormalizedTx[] {
  return docs.map((t) => ({
    id: String(t.id ?? ""),
    date: String(t.date ?? ""),
    type: t.type === "sell" ? "sell" : "buy",
    assetSymbol: t.asset?.symbol ?? "",
    assetName: t.asset?.name ?? "",
    amount: typeof t.amount === "number" ? t.amount : null,
    unitPrice: typeof t.unitPrice === "number" ? t.unitPrice : null,
    totalValue: typeof t.totalValue === "number" ? t.totalValue : null,
  }))
}

function summarize(txs: NormalizedTx[]): Summary {
  // Treat ZEC transactions only (the company holds only ZEC right now;
  // future-proof by filtering on the symbol). Skip rows where amount is
  // null or 0 — those appear to be placeholder / draft entries upstream
  // (e.g. one row in the live feed has amount=0 and totalValue=\$5M).
  const zec = txs.filter(
    (t) => t.assetSymbol === "ZEC" && (t.amount ?? 0) > 0
  )
  let totalZec = 0
  let totalCostUSD = 0
  let buyCount = 0
  let sellCount = 0
  for (const t of zec) {
    const sign = t.type === "buy" ? 1 : -1
    totalZec += (t.amount ?? 0) * sign
    totalCostUSD += (t.totalValue ?? 0) * sign
    if (t.type === "buy") buyCount++
    else sellCount++
  }
  const sortedByDate = txs.toSorted((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
  return {
    totalZec,
    totalCostUSD,
    avgCostPerZec: totalZec > 0 ? totalCostUSD / totalZec : null,
    transactionCount: txs.length,
    buyCount,
    sellCount,
    firstTransactionAt: sortedByDate[0]?.date ?? null,
    lastTransactionAt: sortedByDate[sortedByDate.length - 1]?.date ?? null,
  }
}

/** CoinGecko free-tier endpoint, primary supply source. */
async function fetchSupplyCoinGecko(): Promise<number | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      market_data?: { circulating_supply?: number | null }
    }
    const v = json.market_data?.circulating_supply
    return typeof v === "number" && v > 0 ? v : null
  } catch {
    return null
  }
}

/** CoinPaprika fallback — different rate-limit pool than CoinGecko, also
 *  free, no auth. Used when CoinGecko is rate-limited or down. */
async function fetchSupplyCoinPaprika(): Promise<number | null> {
  try {
    const res = await fetch(COINPAPRIKA_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as { circulating_supply?: number | null }
    const v = json.circulating_supply
    return typeof v === "number" && v > 0 ? v : null
  } catch {
    return null
  }
}

/**
 * Get ZEC circulating supply with KV-backed caching.
 *
 * Lookup order:
 *   1. Workers KV (24h TTL) — shared across all regions, single source
 *      of truth, survives worker restarts. The vast majority of requests
 *      hit this and never touch upstream.
 *   2. CoinGecko (free, 30 req/min limit per IP).
 *   3. CoinPaprika (free, separate rate-limit pool).
 *
 * If both upstreams fail and KV is empty, returns null and the supply
 * card / progress chip self-hide rather than rendering a fake number.
 */
interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>
}

async function fetchCirculatingSupply(): Promise<number | null> {
  let kv: KVLike | null = null
  try {
    // OpenNext exposes the Cloudflare runtime context (env bindings, ctx)
    // here. Async form because route handlers run inside an async wrapper.
    const ctx = await getCloudflareContext({ async: true })
    kv = (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
  } catch (err) {
    console.error("[supply] getCloudflareContext failed:", err)
  }

  // 1) KV cache hit
  if (kv) {
    try {
      const cached = await kv.get(SUPPLY_KV_KEY)
      if (cached) {
        const v = parseFloat(cached)
        if (Number.isFinite(v) && v > 0) {
          console.log("[supply] KV hit:", v)
          return v
        }
      }
    } catch (err) {
      console.error("[supply] KV read failed:", err)
    }
  } else {
    console.warn("[supply] no KV binding — falling through to upstream")
  }

  // 2) Upstream chain
  let supply = await fetchSupplyCoinGecko()
  if (supply != null) {
    console.log("[supply] CoinGecko returned:", supply)
  } else {
    console.warn("[supply] CoinGecko returned null, trying CoinPaprika")
    supply = await fetchSupplyCoinPaprika()
    if (supply != null) {
      console.log("[supply] CoinPaprika returned:", supply)
    } else {
      console.warn("[supply] both upstreams returned null")
    }
  }

  // 3) Persist for the next 24h, all regions
  if (supply != null && kv) {
    try {
      await kv.put(SUPPLY_KV_KEY, String(supply), {
        expirationTtl: SUPPLY_TTL_SECONDS,
      })
      console.log("[supply] wrote to KV")
    } catch (err) {
      console.error("[supply] KV write failed:", err)
    }
  }

  return supply
}

function computeSupply(totalZec: number, circulating: number | null): SupplyInfo {
  const max = 21_000_000
  const pctOfCirculating =
    circulating != null && circulating > 0
      ? (totalZec / circulating) * 100
      : null
  const pctOfMax = max > 0 ? (totalZec / max) * 100 : null
  const progressTowardTarget =
    pctOfCirculating != null && TARGET_PCT_OF_SUPPLY > 0
      ? Math.min(pctOfCirculating / TARGET_PCT_OF_SUPPLY, 1)
      : null
  return {
    circulating,
    max,
    pctOfCirculating,
    pctOfMax,
    targetPct: TARGET_PCT_OF_SUPPLY,
    progressTowardTarget,
  }
}

export async function GET() {
  try {
    // Fetch transactions + ZEC supply in parallel. Supply failure is
    // non-fatal — we still return holdings, just without the % stats.
    const [txRes, circulating] = await Promise.all([
      fetch(TRANSACTIONS_URL, { headers: HEADERS, cache: "no-store" }),
      fetchCirculatingSupply(),
    ])
    if (!txRes.ok) throw new Error(`upstream ${txRes.status}`)
    const json = (await txRes.json()) as UpstreamResponse
    const txs = normalize(json.docs ?? [])
    // Newest first for display
    txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    const summary = summarize(txs)
    const supply = computeSupply(summary.totalZec, circulating)
    return NextResponse.json(
      { transactions: txs, summary, supply, fetchedAt: Date.now() },
      {
        headers: {
          // CF edge caches for 6h, stale-while-revalidate for 24h. Buys
          // happen at most every few weeks; ZEC supply ticks once per
          // day, so this is plenty fresh for both.
          "Cache-Control":
            "public, s-maxage=21600, stale-while-revalidate=86400",
        },
      }
    )
  } catch (err) {
    console.error("[v0] cypherpunk-holdings: upstream fetch failed", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    )
  }
}
