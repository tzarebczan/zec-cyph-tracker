import { NextResponse } from "next/server"

// Yahoo Finance v8 chart endpoint — works without crumb/cookie unlike v7/finance/quote.
// `includePrePost=true` packs pre- and post-market data into the same series so we can
// derive an "extended hours" price for CYPH on top of the regular session.
const YAHOO_CHART =
  "https://query1.finance.yahoo.com/v8/finance/chart/CYPH?interval=1m&range=1d&includePrePost=true"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

type TradingPeriod = { start: number; end: number }
type CurrentTradingPeriod = {
  pre?: TradingPeriod
  regular?: TradingPeriod
  post?: TradingPeriod
}

function deriveMarketState(period: CurrentTradingPeriod | null): string {
  if (!period) return "CLOSED"
  const now = Math.floor(Date.now() / 1000)
  if (period.regular && now >= period.regular.start && now < period.regular.end) return "REGULAR"
  if (period.pre && now >= period.pre.start && now < period.pre.end) return "PRE"
  if (period.post && now >= period.post.start && now < period.post.end) return "POST"
  if (period.pre && now < period.pre.start) return "PREPRE"
  if (period.post && now >= period.post.end) return "POSTPOST"
  return "CLOSED"
}

/** Find the latest non-null close inside an inclusive timestamp range. */
function lastInRange(
  timestamps: number[],
  closes: (number | null)[],
  range: TradingPeriod | undefined
): { price: number; time: number } | null {
  if (!range) return null
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const t = timestamps[i]
    const c = closes[i]
    if (c == null || isNaN(c)) continue
    if (t >= range.start && t <= range.end) return { price: c, time: t }
  }
  return null
}

export async function GET() {
  try {
    const res = await fetch(YAHOO_CHART, {
      headers: HEADERS,
      next: { revalidate: 15 },
    })

    if (!res.ok) throw new Error(`Yahoo chart fetch failed: ${res.status}`)

    const json = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) throw new Error("Yahoo chart: empty result")

    const meta = result.meta ?? {}
    const timestamps: number[] = result.timestamp ?? []
    const closes: (number | null)[] =
      result.indicators?.quote?.[0]?.close ?? []
    const period: CurrentTradingPeriod | null = meta.currentTradingPeriod ?? null

    const regularPrice: number | null = meta.regularMarketPrice ?? null
    const prevClose: number | null =
      meta.chartPreviousClose ?? meta.previousClose ?? null
    const regularChange =
      regularPrice != null && prevClose != null ? regularPrice - prevClose : null
    const regularChangePct =
      regularPrice != null && prevClose != null && prevClose > 0
        ? ((regularPrice - prevClose) / prevClose) * 100
        : null

    const pre = lastInRange(timestamps, closes, period?.pre)
    const post = lastInRange(timestamps, closes, period?.post)

    // Extended-hours change is measured against the regular session reference price.
    const preChange =
      pre && regularPrice != null ? pre.price - regularPrice : null
    const preChangePct =
      pre && regularPrice != null && regularPrice > 0
        ? ((pre.price - regularPrice) / regularPrice) * 100
        : null
    const postChange =
      post && regularPrice != null ? post.price - regularPrice : null
    const postChangePct =
      post && regularPrice != null && regularPrice > 0
        ? ((post.price - regularPrice) / regularPrice) * 100
        : null

    const marketState: string = meta.marketState ?? deriveMarketState(period)

    return NextResponse.json({
      symbol: meta.symbol ?? "CYPH",
      shortName: "Cypherpunk Holdings",
      currency: meta.currency ?? "USD",
      marketState,
      regularMarketPrice: regularPrice,
      regularMarketChange: regularChange,
      regularMarketChangePercent: regularChangePct,
      regularMarketPreviousClose: prevClose,
      regularMarketTime: meta.regularMarketTime ?? null,
      preMarketPrice: pre?.price ?? null,
      preMarketChange: preChange,
      preMarketChangePercent: preChangePct,
      preMarketTime: pre?.time ?? null,
      postMarketPrice: post?.price ?? null,
      postMarketChange: postChange,
      postMarketChangePercent: postChangePct,
      postMarketTime: post?.time ?? null,
    })
  } catch (err) {
    console.error("[v0] Quote API error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
