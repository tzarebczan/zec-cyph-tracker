import { NextResponse } from "next/server"

// ZEC  — Kraken public OHLC, no key, up to 720 daily candles
// CYPH — Yahoo Finance v8 chart API, no key, NASDAQ stock (Cypherpunk Technologies Inc)
//         CYPH started holding ZEC on Nov 12 2025 — that's the earliest meaningful date.
const KRAKEN_BASE = "https://api.kraken.com/0/public"
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
const CYPH_TICKER = "CYPH"
// Nov 12 2025 00:00 UTC in seconds — the "all time" start for this tracker
// (the day CYPH first started holding ZEC).
const CYPH_ZEC_START_UNIX = 1762905600

/** Format a unix-ms timestamp to "Mon DD" or "Mon DD 'YY" for multi-year spans */
function fmtDate(ts: number, includeYear = false) {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  if (includeYear) opts.year = "2-digit"
  return new Date(ts).toLocaleDateString("en-US", opts)
}

/** Fetch with up to maxRetries automatic retries on transient errors */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options)
      if (res.ok) return res
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)))
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return res // 4xx non-retryable — return so caller can handle
    } catch (e) {
      lastErr = e
      if (i < maxRetries) await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * Kraken daily OHLC for ZEC.
 * rows = [time(s), open, high, low, close, vwap, volume, count]
 * Kraken returns max 720 rows per request.
 */
async function fetchZecKraken(since: number): Promise<Map<string, { ts: number; price: number }>> {
  const res = await fetchWithRetry(
    `${KRAKEN_BASE}/OHLC?pair=ZECUSD&interval=1440&since=${since}`,
    { next: { revalidate: 600 } }
  )
  if (!res.ok) throw new Error(`Kraken ZEC fetch failed: ${res.status}`)
  const json = await res.json()
  if (json.error?.length) throw new Error(`Kraken error: ${json.error[0]}`)
  const rows: [number, string, string, string, string, string, string, number][] =
    Object.values(json.result ?? {})[0] as never
  const map = new Map<string, { ts: number; price: number }>()
  for (const row of rows ?? []) {
    const ts = row[0] * 1000
    const price = parseFloat(row[4]) // close
    map.set(new Date(ts).toISOString().slice(0, 10), { ts, price })
  }
  return map
}

/**
 * Yahoo Finance v8 chart for CYPH (NASDAQ stock).
 * Returns daily OHLC for any range up to ~2 years with no API key.
 * We pick adjusted close for accuracy.
 */
async function fetchCyphYahoo(period1: number, period2: number): Promise<Map<string, { ts: number; price: number }>> {
  const url = `${YAHOO_BASE}/${CYPH_TICKER}?interval=1d&period1=${period1}&period2=${period2}&events=history`
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: 1800 }, // 30 min cache — stock market only updates daily
  })
  if (!res.ok) throw new Error(`Yahoo Finance CYPH fetch failed: ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error("Yahoo Finance: empty result")
  const timestamps: number[] = result.timestamp ?? []
  const closes: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose
    ?? result.indicators?.quote?.[0]?.close
    ?? []
  const map = new Map<string, { ts: number; price: number }>()
  for (let i = 0; i < timestamps.length; i++) {
    const price = closes[i]
    if (price == null || isNaN(price)) continue
    const ts = timestamps[i] * 1000
    map.set(new Date(ts).toISOString().slice(0, 10), { ts, price })
  }
  return map
}

// Map period param → days back from today (null = "all" from Nov 12 2025).
// `null` is the sentinel for "all" so we can't use `?? 7` to default — that
// collapses null to 7 and silently turns "All" into a 7-day chart.
const PERIOD_DAYS: Record<string, number | null> = {
  "7": 7,
  "14": 14,
  "30": 30,
  "90": 90,
  "180": 180,
  "all": null,
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get("days") ?? "7"
  const daysBack = period in PERIOD_DAYS ? PERIOD_DAYS[period] : 7

  const nowUnix = Math.floor(Date.now() / 1000)
  const period1 = daysBack === null ? CYPH_ZEC_START_UNIX : nowUnix - daysBack * 86400
  const includeYear = daysBack === null || (daysBack ?? 0) > 180

  try {
    const [zecByDay, cyphByDay] = await Promise.all([
      fetchZecKraken(period1 - 86400 * 2), // 2 extra days buffer for alignment
      fetchCyphYahoo(period1, nowUnix),
    ])

    // Intersect dates present in both, sorted ascending, clipped to start date
    const startKey = new Date(period1 * 1000).toISOString().slice(0, 10)
    const sharedDates = [...cyphByDay.keys()]
      .filter((d) => zecByDay.has(d) && d >= startKey)
      .sort()

    const history = sharedDates.map((dateKey) => {
      const { ts, price: cyph } = cyphByDay.get(dateKey)!
      const { price: zec } = zecByDay.get(dateKey)!
      const ratio = zec > 0 ? cyph / zec : null
      return { timestamp: ts, date: fmtDate(ts, includeYear), cyph, zec, ratio }
    })

    // Current prices: Kraken ticker for ZEC live, Yahoo meta for CYPH
    const [zecTickerRes, cyphQuoteRes] = await Promise.all([
      fetchWithRetry(`${KRAKEN_BASE}/Ticker?pair=ZECUSD`, { next: { revalidate: 60 } }),
      fetchWithRetry(
        `${YAHOO_BASE}/${CYPH_TICKER}?interval=1d&range=5d`,
        { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } }
      ),
    ])

    const zecTicker = zecTickerRes.ok ? await zecTickerRes.json() : {}
    const cyphQuote = cyphQuoteRes.ok ? await cyphQuoteRes.json() : {}

    // Kraken: result[pair].c[0] = last trade price, .o = today's open
    const zecPairData: Record<string, { c: string[]; o: string }> = zecTicker.result ?? {}
    const zecPairKey = Object.keys(zecPairData)[0] ?? ""
    const zecPrice = zecPairData[zecPairKey]?.c?.[0] ? parseFloat(zecPairData[zecPairKey].c[0]) : null
    const zecOpen = zecPairData[zecPairKey]?.o ? parseFloat(zecPairData[zecPairKey].o) : null
    const zecChange24h = zecPrice != null && zecOpen != null && zecOpen > 0
      ? ((zecPrice - zecOpen) / zecOpen) * 100
      : null

    // Yahoo: meta.regularMarketPrice = current price, meta.previousClose = prev close
    const cyphMeta = cyphQuote?.chart?.result?.[0]?.meta ?? {}
    const cyphPrice: number | null = cyphMeta.regularMarketPrice ?? null
    const cyphPrevClose: number | null = cyphMeta.previousClose ?? cyphMeta.chartPreviousClose ?? null
    const cyphChange24h = cyphPrice != null && cyphPrevClose != null && cyphPrevClose > 0
      ? ((cyphPrice - cyphPrevClose) / cyphPrevClose) * 100
      : null

    return NextResponse.json({
      history,
      current: {
        cyph: { price: cyphPrice, change24h: cyphChange24h },
        zec: { price: zecPrice, change24h: zecChange24h },
      },
    })
  } catch (err) {
    console.error("[v0] Price API error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
