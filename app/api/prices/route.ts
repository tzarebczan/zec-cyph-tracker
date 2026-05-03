import { NextResponse } from "next/server"

// CoinGecko API – CYPH = "cypherpunk-holdings", ZEC = "zcash"
const COINGECKO_BASE = "https://api.coingecko.com/api/v3"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const days = searchParams.get("days") ?? "7"

  try {
    const [cyphRes, zecRes] = await Promise.all([
      fetch(
        `${COINGECKO_BASE}/coins/cypherpunk-holdings/market_chart?vs_currency=usd&days=${days}&interval=daily`,
        { next: { revalidate: 300 } }
      ),
      fetch(
        `${COINGECKO_BASE}/coins/zcash/market_chart?vs_currency=usd&days=${days}&interval=daily`,
        { next: { revalidate: 300 } }
      ),
    ])

    if (!cyphRes.ok || !zecRes.ok) {
      throw new Error("CoinGecko fetch failed")
    }

    const [cyphData, zecData] = await Promise.all([
      cyphRes.json(),
      zecRes.json(),
    ])

    // Align by timestamp – zip the two arrays by index (both return same interval)
    const cyphPrices: [number, number][] = cyphData.prices ?? []
    const zecPrices: [number, number][] = zecData.prices ?? []

    const minLen = Math.min(cyphPrices.length, zecPrices.length)

    const combined = Array.from({ length: minLen }, (_, i) => {
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

    // Also grab current prices for the stat cards
    const currentRes = await fetch(
      `${COINGECKO_BASE}/simple/price?ids=cypherpunk-holdings,zcash&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 60 } }
    )
    const currentData = currentRes.ok ? await currentRes.json() : {}

    return NextResponse.json({
      history: combined,
      current: {
        cyph: {
          price: currentData["cypherpunk-holdings"]?.usd ?? null,
          change24h: currentData["cypherpunk-holdings"]?.usd_24h_change ?? null,
        },
        zec: {
          price: currentData["zcash"]?.usd ?? null,
          change24h: currentData["zcash"]?.usd_24h_change ?? null,
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
