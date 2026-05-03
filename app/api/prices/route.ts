import { NextResponse } from "next/server"

// CoinGecko API – CYPH = "cypher-3" (symbol CYPH), ZEC = "zcash"
const COINGECKO_BASE = "https://api.coingecko.com/api/v3"
const CYPH_ID = "cypher-3"
const ZEC_ID = "zcash"

/** Fetch with a single automatic retry after 1 s on 429 */
async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options)
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1200))
    return fetch(url, options)
  }
  return res
}

/**
 * CoinGecko returns hourly data for days <= 90 regardless of the interval param.
 * We downsample to one value per calendar day by keeping the LAST tick of each day.
 * Keys the map by "YYYY-MM-DD" so we can align CYPH and ZEC by date string.
 */
function toDailyMap(prices: [number, number][]): Map<string, { ts: number; price: number }> {
  const map = new Map<string, { ts: number; price: number }>()
  for (const [ts, price] of prices) {
    const key = new Date(ts).toISOString().slice(0, 10) // "YYYY-MM-DD"
    // Overwrite so the last entry of each day wins
    map.set(key, { ts, price })
  }
  return map
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const days = searchParams.get("days") ?? "7"

  try {
    // Stagger the two history requests by 600 ms to avoid simultaneous rate-limit hits
    // Do NOT pass interval=daily — CoinGecko ignores it on the free tier for days<=90
    const cyphRes = await fetchWithRetry(
      `${COINGECKO_BASE}/coins/${CYPH_ID}/market_chart?vs_currency=usd&days=${days}`,
      { next: { revalidate: 300 } }
    )
    await new Promise((r) => setTimeout(r, 600))
    const zecRes = await fetchWithRetry(
      `${COINGECKO_BASE}/coins/${ZEC_ID}/market_chart?vs_currency=usd&days=${days}`,
      { next: { revalidate: 300 } }
    )

    if (!cyphRes.ok || !zecRes.ok) {
      const errBody = !cyphRes.ok ? await cyphRes.text() : await zecRes.text()
      console.error("[v0] CoinGecko error body:", errBody)
      throw new Error(`CoinGecko fetch failed: ${cyphRes.status} / ${zecRes.status}`)
    }

    const cyphData = await cyphRes.json()
    const zecData = await zecRes.json()

    const cyphPrices: [number, number][] = cyphData.prices ?? []
    const zecPrices: [number, number][] = zecData.prices ?? []

    // Downsample both to one-per-day keyed by date string
    const cyphByDay = toDailyMap(cyphPrices)
    const zecByDay = toDailyMap(zecPrices)

    // Only keep dates present in both coins, sorted ascending
    const sharedDates = [...cyphByDay.keys()]
      .filter((d) => zecByDay.has(d))
      .sort()

    const history = sharedDates.map((dateKey) => {
      const { ts, price: cyph } = cyphByDay.get(dateKey)!
      const { price: zec } = zecByDay.get(dateKey)!
      const ratio = zec > 0 ? cyph / zec : null
      return {
        timestamp: ts,
        date: new Date(ts).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        cyph,
        zec,
        ratio,
      }
    })

    // Grab current prices for stat cards (staggered too)
    await new Promise((r) => setTimeout(r, 600))
    const currentRes = await fetchWithRetry(
      `${COINGECKO_BASE}/simple/price?ids=${CYPH_ID},${ZEC_ID}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 60 } }
    )
    const currentData = currentRes.ok ? await currentRes.json() : {}

    return NextResponse.json({
      history,
      current: {
        cyph: {
          price: currentData[CYPH_ID]?.usd ?? null,
          change24h: currentData[CYPH_ID]?.usd_24h_change ?? null,
        },
        zec: {
          price: currentData[ZEC_ID]?.usd ?? null,
          change24h: currentData[ZEC_ID]?.usd_24h_change ?? null,
        },
      },
    })
  } catch (err) {
    console.error("[v0] Price API error:", err)
    return NextResponse.json(
      { error: "Failed to fetch price data" },
      { status: 500 }
    )
  }
}
