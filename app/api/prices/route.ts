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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const days = searchParams.get("days") ?? "7"

  try {
    // Stagger the two history requests by 600 ms to avoid simultaneous rate-limit hits
    const cyphRes = await fetchWithRetry(
      `${COINGECKO_BASE}/coins/${CYPH_ID}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
      { next: { revalidate: 300 } }
    )
    await new Promise((r) => setTimeout(r, 600))
    const zecRes = await fetchWithRetry(
      `${COINGECKO_BASE}/coins/${ZEC_ID}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
      { next: { revalidate: 300 } }
    )

    if (!cyphRes.ok || !zecRes.ok) {
      const errBody = !cyphRes.ok ? await cyphRes.text() : await zecRes.text()
      console.error("[v0] CoinGecko error body:", errBody)
      throw new Error(`CoinGecko fetch failed: ${cyphRes.status} / ${zecRes.status}`)
    }

    const cyphData = await cyphRes.json()
    const zecData = await zecRes.json()

    // Align by index – both endpoints return the same daily interval
    const cyphPrices: [number, number][] = cyphData.prices ?? []
    const zecPrices: [number, number][] = zecData.prices ?? []
    const minLen = Math.min(cyphPrices.length, zecPrices.length)

    const history = Array.from({ length: minLen }, (_, i) => {
      const ts = cyphPrices[i][0]
      const cyph = cyphPrices[i][1]
      const zec = zecPrices[i][1]
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
