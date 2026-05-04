import { NextResponse } from "next/server"

// ZEC: Kraken public OHLC — no API key, no rate limits, daily candles up to 720 days
// CYPH: CoinGecko — only DEX token, no exchange API available; cached aggressively
const KRAKEN_BASE = "https://api.kraken.com/0/public"
const CG_BASE = "https://api.coingecko.com/api/v3"
const CYPH_CG_ID = "cypher-3"

/** Format a timestamp (ms) to "Mon DD" label */
function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/**
 * Kraken OHLC returns rows: [time, open, high, low, close, vwap, volume, count]
 * time is Unix seconds. interval=1440 = daily candles.
 * Returns up to 720 rows sorted ascending.
 */
async function fetchZecKraken(days: number): Promise<Map<string, { ts: number; price: number }>> {
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const res = await fetch(
    `${KRAKEN_BASE}/OHLC?pair=ZECUSD&interval=1440&since=${since}`,
    { next: { revalidate: 600 } }
  )
  if (!res.ok) throw new Error(`Kraken ZEC fetch failed: ${res.status}`)
  const json = await res.json()
  if (json.error?.length) throw new Error(`Kraken error: ${json.error[0]}`)
  // The result key is the pair name (e.g. "XZECZUSD")
  const rows: [number, string, string, string, string, string, string, number][] =
    Object.values(json.result ?? {})[0] as never
  const map = new Map<string, { ts: number; price: number }>()
  for (const row of rows ?? []) {
    const ts = row[0] * 1000
    const price = parseFloat(row[4]) // close price
    const key = new Date(ts).toISOString().slice(0, 10)
    map.set(key, { ts, price })
  }
  return map
}

/**
 * CoinGecko market_chart for CYPH.
 * Cached for 1 hour to avoid rate limits — data freshness is acceptable for a DEX token.
 * Returns hourly ticks; we downsample to one-per-day.
 */
async function fetchCyphCoinGecko(days: number): Promise<Map<string, { ts: number; price: number }>> {
  const res = await fetch(
    `${CG_BASE}/coins/${CYPH_CG_ID}/market_chart?vs_currency=usd&days=${days}`,
    { next: { revalidate: 3600 } }
  )
  if (!res.ok) throw new Error(`CoinGecko CYPH fetch failed: ${res.status}`)
  const json = await res.json()
  const prices: [number, number][] = json.prices ?? []
  const map = new Map<string, { ts: number; price: number }>()
  for (const [ts, price] of prices) {
    const key = new Date(ts).toISOString().slice(0, 10)
    map.set(key, { ts, price }) // last tick of day wins
  }
  return map
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const days = Math.min(Number(searchParams.get("days") ?? "7"), 90)

  try {
    // Fetch ZEC (Kraken) and CYPH (CoinGecko) in parallel
    const [zecByDay, cyphByDay] = await Promise.all([
      fetchZecKraken(days + 2), // fetch a couple extra days to ensure overlap
      fetchCyphCoinGecko(days),
    ])

    // Intersect on shared calendar dates, sorted ascending
    const sharedDates = [...zecByDay.keys()]
      .filter((d) => cyphByDay.has(d))
      .sort()
      .slice(-days) // keep only the requested number of days

    const history = sharedDates.map((dateKey) => {
      const { ts, price: zec } = zecByDay.get(dateKey)!
      const { price: cyph } = cyphByDay.get(dateKey)!
      const ratio = zec > 0 ? cyph / zec : null
      return { timestamp: ts, date: fmtDate(ts), cyph, zec, ratio }
    })

    // Current prices: Kraken ticker for ZEC, CoinGecko simple for CYPH
    const [zecTickerRes, cyphCurrentRes] = await Promise.all([
      fetch(`${KRAKEN_BASE}/Ticker?pair=ZECUSD`, { next: { revalidate: 60 } }),
      fetch(
        `${CG_BASE}/simple/price?ids=${CYPH_CG_ID}&vs_currencies=usd&include_24hr_change=true`,
        { next: { revalidate: 300 } }
      ),
    ])

    const zecTicker = zecTickerRes.ok ? await zecTickerRes.json() : {}
    const cyphCurrent = cyphCurrentRes.ok ? await cyphCurrentRes.json() : {}

    // Kraken ticker: result["XZECZUSD"].c = [lastTradePrice, lotVolume]
    const zecPairData: Record<string, { c: string[]; o: string }> =
      zecTicker.result ?? {}
    const zecPairKey = Object.keys(zecPairData)[0] ?? ""
    const zecPrice = zecPairData[zecPairKey]?.c?.[0]
      ? parseFloat(zecPairData[zecPairKey].c[0])
      : null
    const zecOpen = zecPairData[zecPairKey]?.o
      ? parseFloat(zecPairData[zecPairKey].o)
      : null
    const zecChange24h =
      zecPrice != null && zecOpen != null && zecOpen > 0
        ? ((zecPrice - zecOpen) / zecOpen) * 100
        : null

    return NextResponse.json({
      history,
      current: {
        cyph: {
          price: cyphCurrent[CYPH_CG_ID]?.usd ?? null,
          change24h: cyphCurrent[CYPH_CG_ID]?.usd_24h_change ?? null,
        },
        zec: {
          price: zecPrice,
          change24h: zecChange24h,
        },
      },
    })
  } catch (err) {
    console.error("[v0] Price API error:", err)
    return NextResponse.json({ error: "Failed to fetch price data" }, { status: 500 })
  }
}
