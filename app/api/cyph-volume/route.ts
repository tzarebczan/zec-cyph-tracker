import { NextResponse } from "next/server"

// CYPH share-volume history from Yahoo Finance v8 chart.
// Used by /holdings to show "shares traded" over 24h and 1w windows.

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
const CYPH_TICKER = "CYPH"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface YahooChartResult {
  timestamp?: number[]
  indicators?: {
    quote?: {
      volume?: (number | null)[]
    }[]
  }
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[]
    error?: { description?: string }
  }
}

function positiveNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
  return null
}

async function fetchCyphVolume(
  range: "1d" | "5d",
  interval: "15m" | "1d"
): Promise<number | null> {
  const url = `${YAHOO_BASE}/${CYPH_TICKER}?interval=${interval}&range=${range}&includePrePost=true`
  const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
  if (!res.ok) {
    throw new Error(`Yahoo CYPH volume (${range}) failed: ${res.status}`)
  }
  const json = (await res.json()) as YahooChartResponse
  const result = json?.chart?.result?.[0]
  if (!result) return null

  const volumes = result.indicators?.quote?.[0]?.volume ?? []
  const total = volumes.reduce<number | null>((sum, v) => {
    const n = positiveNumber(v)
    if (n == null) return sum
    return (sum ?? 0) + n
  }, null)
  return total
}

export async function GET() {
  try {
    const [volume24h, volume1w] = await Promise.all([
      fetchCyphVolume("1d", "15m"),
      fetchCyphVolume("5d", "1d"),
    ])

    return NextResponse.json(
      {
        volume24h,
        volume1w,
        fetchedAt: Date.now(),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
        },
      }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : "CYPH volume fetch failed"
    return NextResponse.json(
      { error: msg, volume24h: null, volume1w: null, fetchedAt: Date.now() },
      {
        status: 502,
        headers: { "Cache-Control": "public, max-age=0, s-maxage=10" },
      }
    )
  }
}
