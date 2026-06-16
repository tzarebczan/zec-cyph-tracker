import { NextResponse } from "next/server"

// ZEC  — Kraken public OHLC, no key, up to 720 daily candles
// CYPH — Yahoo Finance v8 chart API, no key, NASDAQ stock (Cypherpunk Technologies Inc)
//         CYPH started holding ZEC on Nov 12 2025 — that's the earliest meaningful date.
const KRAKEN_BASE = "https://api.kraken.com/0/public"
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
const CYPH_TICKER = "CYPH"
const BTC_PAIR = "XBTUSD"
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

async function fetchBtcDaily(since: number): Promise<Map<string, { ts: number; price: number }>> {
  // Kraken accepts both the websocket-style alias (XBTUSD) and the
  // REST canonical name (XXBTZUSD). Some edge POPs/caches are flaky
  // with the alias, so fall back to the canonical pair and then to
  // Yahoo Finance if Kraken is unavailable.
  const tryPairs = [BTC_PAIR, "XXBTZUSD"]
  let lastErr: unknown
  for (const pair of tryPairs) {
    try {
      const res = await fetchWithRetry(
        `${KRAKEN_BASE}/OHLC?pair=${pair}&interval=1440&since=${since}`,
        { next: { revalidate: 600 } }
      )
      if (!res.ok) throw new Error(`Kraken BTC fetch failed: ${res.status}`)
      const json = await res.json()
      if (json.error?.length) throw new Error(`Kraken error: ${json.error[0]}`)
      const rows: [number, string, string, string, string, string, string, number][] =
        Object.values(json.result ?? {})[0] as never
      const map = new Map<string, { ts: number; price: number }>()
      for (const row of rows ?? []) {
        const ts = row[0] * 1000
        const price = parseFloat(row[4])
        map.set(new Date(ts).toISOString().slice(0, 10), { ts, price })
      }
      return map
    } catch (e) {
      lastErr = e
    }
  }
  try {
    return await fetchBtcYahoo(since, Math.floor(Date.now() / 1000))
  } catch (e) {
    throw lastErr ?? e
  }
}

/**
 * Kraken hourly OHLC for ZEC — used for the 1D intraday chart.
 * Returns a list of {ts, price} points covering the last ~24 hours
 * (Kraken caps at 720 candles, so even at 60-min interval we have
 * 30 days of headroom). Sorted ascending by timestamp.
 */
async function fetchZecKrakenIntraday(): Promise<{ ts: number; price: number }[]> {
  // 25h ago — slightly wider than 24h so the chart has a leading data
  // point before the 24h window starts.
  const since = Math.floor(Date.now() / 1000) - 25 * 3600
  const res = await fetchWithRetry(
    `${KRAKEN_BASE}/OHLC?pair=ZECUSD&interval=60&since=${since}`,
    { next: { revalidate: 60 } }
  )
  if (!res.ok) throw new Error(`Kraken ZEC intraday failed: ${res.status}`)
  const json = await res.json()
  if (json.error?.length) throw new Error(`Kraken error: ${json.error[0]}`)
  const rows: [number, string, string, string, string, string, string, number][] =
    Object.values(json.result ?? {})[0] as never
  const out: { ts: number; price: number }[] = []
  for (const row of rows ?? []) {
    const ts = row[0] * 1000
    const price = parseFloat(row[4]) // close
    if (Number.isFinite(price)) out.push({ ts, price })
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

async function fetchBtcIntraday(): Promise<{ ts: number; price: number }[]> {
  const since = Math.floor(Date.now() / 1000) - 25 * 3600
  const tryPairs = [BTC_PAIR, "XXBTZUSD"]
  let lastErr: unknown
  for (const pair of tryPairs) {
    try {
      const res = await fetchWithRetry(
        `${KRAKEN_BASE}/OHLC?pair=${pair}&interval=60&since=${since}`,
        { next: { revalidate: 60 } }
      )
      if (!res.ok) throw new Error(`Kraken BTC intraday failed: ${res.status}`)
      const json = await res.json()
      if (json.error?.length) throw new Error(`Kraken error: ${json.error[0]}`)
      const rows: [number, string, string, string, string, string, string, number][] =
        Object.values(json.result ?? {})[0] as never
      const out: { ts: number; price: number }[] = []
      for (const row of rows ?? []) {
        const ts = row[0] * 1000
        const price = parseFloat(row[4])
        if (Number.isFinite(price)) out.push({ ts, price })
      }
      out.sort((a, b) => a.ts - b.ts)
      return out
    } catch (e) {
      lastErr = e
    }
  }
  // Fallback to Yahoo 15-minute BTC-USD candles for the current session.
  try {
    const url = `${YAHOO_BASE}/BTC-USD?interval=15m&range=1d&includePrePost=true`
    const res = await fetchWithRetry(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 60 },
    })
    if (!res.ok) throw new Error(`Yahoo BTC intraday failed: ${res.status}`)
    const json = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) throw new Error("Yahoo BTC intraday: empty result")
    const timestamps: number[] = result.timestamp ?? []
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []
    const out: { ts: number; price: number }[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const price = closes[i]
      if (price == null || !Number.isFinite(price)) continue
      out.push({ ts: timestamps[i] * 1000, price })
    }
    out.sort((a, b) => a.ts - b.ts)
    return out
  } catch (e) {
    throw lastErr ?? e
  }
}

/**
 * Yahoo Finance v8 chart for CYPH at 15-min granularity — used for the
 * 1D intraday chart. `range=1d` returns today's session (or the most
 * recent open session); `interval=15m` gives ~26 candles for a full
 * 6.5h session, fewer when called partway through the day.
 */
async function fetchCyphYahooIntraday(): Promise<{ ts: number; price: number }[]> {
  const url = `${YAHOO_BASE}/${CYPH_TICKER}?interval=15m&range=1d&includePrePost=true`
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: 60 },
  })
  if (!res.ok) throw new Error(`Yahoo CYPH intraday failed: ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error("Yahoo intraday: empty result")
  const timestamps: number[] = result.timestamp ?? []
  // For intraday, indicators.quote[0].close holds per-candle close. We
  // prefer close over adjclose because at intraday granularity the two
  // are identical for non-dividend-adjusted ticks, and `adjclose` is
  // often null on partial candles.
  const closes: (number | null)[] =
    result.indicators?.quote?.[0]?.close ?? []
  const out: { ts: number; price: number }[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const price = closes[i]
    if (price == null || !Number.isFinite(price)) continue
    out.push({ ts: timestamps[i] * 1000, price })
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
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

/**
 * Yahoo Finance v8 chart for BTC-USD. Used as a fallback when Kraken's
 * BTC OHLC endpoint is flaky, so the BTC/ZEC overlay mode always has
 * historical data to render.
 */
async function fetchBtcYahoo(period1: number, period2: number): Promise<Map<string, { ts: number; price: number }>> {
  const url = `${YAHOO_BASE}/BTC-USD?interval=1d&period1=${period1}&period2=${period2}&events=history`
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: 1800 },
  })
  if (!res.ok) throw new Error(`Yahoo BTC fetch failed: ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error("Yahoo BTC: empty result")
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
// "1" is a sentinel for the intraday-chart path — the chart uses 15-min
// CYPH candles + hourly ZEC candles for the last ~24 hours instead of
// daily closes. The number 1 is meaningless for daily lookups; the
// branch in GET() reads the period string directly and never indexes
// PERIOD_DAYS with "1".
const PERIOD_DAYS: Record<string, number | null> = {
  "1": 1,
  "7": 7,
  "14": 14,
  "30": 30,
  "90": 90,
  "180": 180,
  "all": null,
}

// Stats are always computed over a 90-day window so the 7/30/90d performance
// badges work regardless of which chart period the user has selected. We
// fetch a small buffer beyond that so the 90D chip resolves even when the
// requested period only just covers 90 calendar days — without the buffer,
// the oldest available candle on a 90D request can be a few days short of
// 90 (markets are closed weekends + holidays) and the lookup returns null.
const STATS_LOOKBACK_DAYS = 90
const STATS_FETCH_BUFFER_DAYS = 14

interface HistoryPoint {
  timestamp: number
  date: string
  cyph: number | null
  btc: number | null
  zec: number
  ratio: number | null
  zecBtcRatio: number | null
}

interface PriceStats {
  cyph: {
    change24h: number | null
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
  zec: {
    change24h: number | null
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
  ratio: {
    avg24h: number | null
    avg7d: number | null
    avg30d: number | null
    avg3m: number | null
    vsAvg24h: number | null
    vsAvg7d: number | null
    vsAvg30d: number | null
    vsAvg3m: number | null
  }
}

function computeStats(
  fullHistory: HistoryPoint[],
  liveCyph: number | null,
  liveZec: number | null
): PriceStats {
  // Reference "current" prices: prefer live ticks; fall back to last close.
  const refCyph = liveCyph ?? latestHistoryValue(fullHistory, "cyph")
  const refZec = liveZec ?? latestHistoryValue(fullHistory, "zec")
  const refRatio =
    refCyph != null && refZec != null && refZec > 0 ? refCyph / refZec : null

  /** Price from approximately N *calendar* days ago. CYPH only has ~64
   *  trading-day candles in a 90-day calendar window, so indexing by
   *  position would mis-align — we walk by timestamp instead and pick the
   *  most recent candle on or before the cutoff. */
  function priceNDaysAgo(daysBack: number, key: "cyph" | "zec" | "btc"): number | null {
    const cutoffMs = Date.now() - daysBack * 86400_000
    let result: number | null = null
    for (const h of fullHistory) {
      if (h.timestamp > cutoffMs) break
      if (h[key] != null) result = h[key] ?? null
    }
    return result
  }

  function pctChange(from: number | null, to: number | null): number | null {
    if (from == null || to == null || from === 0) return null
    return ((to - from) / from) * 100
  }

  const cyph = {
    change24h: pctChange(priceNDaysAgo(1, "cyph"), refCyph),
    change7d: pctChange(priceNDaysAgo(7, "cyph"), refCyph),
    change30d: pctChange(priceNDaysAgo(30, "cyph"), refCyph),
    change90d: pctChange(priceNDaysAgo(90, "cyph"), refCyph),
  }
  const zec = {
    change24h: pctChange(priceNDaysAgo(1, "zec"), refZec),
    change7d: pctChange(priceNDaysAgo(7, "zec"), refZec),
    change30d: pctChange(priceNDaysAgo(30, "zec"), refZec),
    change90d: pctChange(priceNDaysAgo(90, "zec"), refZec),
  }

  // Ratio averages: average the daily ratios that fall inside a *calendar*
  // window. Indexing by candle position would misrepresent — CYPH only
  // trades 5 days a week, so 7 candles is closer to 10 calendar days.
  function avgInWindow(daysBack: number): number | null {
    const cutoffMs = Date.now() - daysBack * 86400_000
    const inWindow = fullHistory.flatMap((h) =>
      h.timestamp >= cutoffMs && h.ratio != null && h.ratio > 0
        ? [h.ratio]
        : []
    )
    if (inWindow.length === 0) return null
    return inWindow.reduce((a, b) => a + b, 0) / inWindow.length
  }
  // 24h avg uses just the most recent daily close ratio (our finest grain).
  const lastRatio =
    [...fullHistory].reverse().find((h) => h.ratio != null && h.ratio > 0)
      ?.ratio ?? null
  const avg24h = lastRatio
  const avg7d = avgInWindow(7)
  const avg30d = avgInWindow(30)
  const avg3m = avgInWindow(90)
  const vsAvg = (avg: number | null) =>
    avg != null && avg > 0 && refRatio != null ? ((refRatio - avg) / avg) * 100 : null

  return {
    cyph,
    zec,
    ratio: {
      avg24h,
      avg7d,
      avg30d,
      avg3m,
      vsAvg24h: vsAvg(avg24h),
      vsAvg7d: vsAvg(avg7d),
      vsAvg30d: vsAvg(avg30d),
      vsAvg3m: vsAvg(avg3m),
    },
  }
}

function latestHistoryValue(
  fullHistory: HistoryPoint[],
  key: "cyph" | "zec" | "btc"
): number | null {
  for (let i = fullHistory.length - 1; i >= 0; i--) {
    const value = fullHistory[i][key]
    if (value != null && Number.isFinite(value)) return value
  }
  return null
}

function pctFromHistory(
  fullHistory: HistoryPoint[],
  key: "cyph" | "zec" | "btc",
  live: number | null,
  daysBack = 1
): number | null {
  const cutoffMs = Date.now() - daysBack * 86400_000
  let from: number | null = null
  for (const h of fullHistory) {
    if (h.timestamp > cutoffMs) break
    if (h[key] != null) from = h[key] ?? null
  }
  const latest = live ?? latestHistoryValue(fullHistory, key)
  if (from == null || latest == null || from === 0) return null
  return ((latest - from) / from) * 100
}

/** Format a unix-ms timestamp as "HH:MM" in the viewer's locale.
 *  Used for 1D intraday chart x-axis labels so consecutive candles
 *  read as wall-clock times rather than the same date string. */
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

/**
 * Merge two intraday streams (ZEC hourly + CYPH 15m) into a single
 * series keyed on ZEC's timestamps. For each ZEC candle, the CYPH
 * value is the most-recent Yahoo intraday tick at or before that
 * timestamp; if no Yahoo tick is yet available (e.g. market hasn't
 * opened today), we fall back to the most recent daily close so the
 * ratio line doesn't gap.
 */
function mergeIntraday(
  zec: { ts: number; price: number }[],
  cyph: { ts: number; price: number }[],
  btc: { ts: number; price: number }[],
  fallbackCyph: number | null,
  fallbackBtc: number | null
): HistoryPoint[] {
  if (zec.length === 0) return []
  // Trim to the last 24 hours so a single warm fetch doesn't show 25h.
  const cutoff = Date.now() - 24 * 3600 * 1000
  const recent = zec.filter((z) => z.ts >= cutoff)
  const out: HistoryPoint[] = []
  let ci = 0 // running pointer into the cyph series — both sides are
  //          sorted ascending so we only ever move forward.
  let bi = 0
  let lastCyph = fallbackCyph
  let lastBtc = fallbackBtc
  for (const z of recent) {
    while (ci < cyph.length && cyph[ci].ts <= z.ts) {
      lastCyph = cyph[ci].price
      ci++
    }
    while (bi < btc.length && btc[bi].ts <= z.ts) {
      lastBtc = btc[bi].price
      bi++
    }
    if (lastCyph == null && lastBtc == null) continue
    const ratio = lastCyph != null && z.price > 0 ? lastCyph / z.price : null
    const zecBtcRatio = lastBtc != null && lastBtc > 0 ? z.price / lastBtc : null
    out.push({
      timestamp: z.ts,
      date: fmtTime(z.ts),
      cyph: lastCyph,
      btc: lastBtc,
      zec: z.price,
      ratio,
      zecBtcRatio,
    })
  }
  return out
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get("days") ?? "7"
  const daysBack = period in PERIOD_DAYS ? PERIOD_DAYS[period] : 7
  const isIntraday = period === "1"

  const nowUnix = Math.floor(Date.now() / 1000)
  const chartStartUnix =
    daysBack === null ? CYPH_ZEC_START_UNIX : nowUnix - daysBack * 86400
  // Always fetch enough data for stats — 90 days plus a small buffer so the
  // 90D chip still resolves when the requested period is exactly 90 days
  // (the oldest available candle inside a 90-day window can be a few days
  // short of 90 because of weekends + holidays). The chart history is sliced
  // back to the user's requested period below, so this only widens the
  // server-side stats window, not the chart.
  const statsStartUnix =
    nowUnix - (STATS_LOOKBACK_DAYS + STATS_FETCH_BUFFER_DAYS) * 86400
  // For 1D intraday, stats still need the 90D daily window — only the
  // chart switches to intraday. So always fetch from `statsStartUnix`
  // regardless of the period selector.
  const fetchStartUnix = isIntraday
    ? statsStartUnix
    : Math.min(chartStartUnix, statsStartUnix)
  const includeYear = daysBack === null || (daysBack ?? 0) > 180

  try {
    // Daily fetch — drives the 90D stats window in every mode, and the
    // chart history in non-intraday modes.
    const [zecByDay, btcByDay, cyphByDay] = await Promise.all([
      fetchZecKraken(fetchStartUnix - 86400 * 2), // 2 extra days buffer for alignment
      fetchBtcDaily(fetchStartUnix - 86400 * 2).catch((err) => {
        console.warn("[prices] BTC daily fetch failed:", err)
        return new Map<string, { ts: number; price: number }>()
      }),
      fetchCyphYahoo(fetchStartUnix, nowUnix),
    ])

    // Build the full daily history (everything we fetched). In daily
    // modes this also becomes the chart. In intraday mode it's only
    // used for stats.
    const allDates = [...new Set([...zecByDay.keys(), ...btcByDay.keys(), ...cyphByDay.keys()])]
      .filter((d) => zecByDay.has(d))
      .sort()
    const fullHistory: HistoryPoint[] = allDates.map((dateKey) => {
      const { ts, price: zec } = zecByDay.get(dateKey)!
      const cyph = cyphByDay.get(dateKey)?.price ?? null
      const btc = btcByDay.get(dateKey)?.price ?? null
      const ratio = cyph != null && zec > 0 ? cyph / zec : null
      const zecBtcRatio = btc != null && btc > 0 ? zec / btc : null
      return { timestamp: ts, date: fmtDate(ts, includeYear), cyph, btc, zec, ratio, zecBtcRatio }
    })
    let history: HistoryPoint[]
    if (isIntraday) {
      // 1D mode — chart is built from intraday candles, aligned to
      // ZEC's hourly grid. For each ZEC hourly candle, the matching
      // CYPH price is the most-recent Yahoo intraday tick at or
      // before that timestamp (so off-market hours show the last
      // intraday close, not a hole in the line).
      const [zecIntra, btcIntra, cyphIntra] = await Promise.all([
        fetchZecKrakenIntraday().catch(() => []),
        fetchBtcIntraday().catch((err) => {
          console.warn("[prices] BTC intraday fetch failed:", err)
          return []
        }),
        fetchCyphYahooIntraday().catch(() => []),
      ])
      const lastDailyCyph =
        fullHistory.length > 0
          ? fullHistory[fullHistory.length - 1].cyph
          : null
      const lastDailyBtc =
        fullHistory.length > 0
          ? fullHistory[fullHistory.length - 1].btc
          : null
      const intraday = mergeIntraday(
        zecIntra,
        cyphIntra,
        btcIntra,
        lastDailyCyph,
        lastDailyBtc
      )
      history = intraday
    } else {
      const chartStartMs = chartStartUnix * 1000
      history = fullHistory.filter((h) => h.timestamp >= chartStartMs)
    }

    // Current prices: Kraken ticker for ZEC live, Yahoo meta for CYPH
    const [zecTickerRes, btcTickerRes, cyphQuoteRes] = await Promise.all([
      fetchWithRetry(`${KRAKEN_BASE}/Ticker?pair=ZECUSD`, { next: { revalidate: 60 } }),
      fetchWithRetry(`${KRAKEN_BASE}/Ticker?pair=${BTC_PAIR}`, { next: { revalidate: 60 } })
        .catch((err) => {
          console.warn("[prices] BTC ticker fetch failed:", err)
          return null
        }),
      fetchWithRetry(
        `${YAHOO_BASE}/${CYPH_TICKER}?interval=1d&range=5d`,
        { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } }
      ),
    ])

    const zecTicker = zecTickerRes.ok ? await zecTickerRes.json() : {}
    const btcTicker = btcTickerRes?.ok ? await btcTickerRes.json() : {}
    const cyphQuote = cyphQuoteRes.ok ? await cyphQuoteRes.json() : {}

    // Kraken: result[pair].c[0] = last trade price, .o = today's open
    const zecPairData: Record<string, { c: string[]; o: string }> = zecTicker.result ?? {}
    const zecPairKey = Object.keys(zecPairData)[0] ?? ""
    const zecPrice = zecPairData[zecPairKey]?.c?.[0] ? parseFloat(zecPairData[zecPairKey].c[0]) : null
    const btcPairData: Record<string, { c: string[]; o: string }> = btcTicker.result ?? {}
    const btcPairKey = Object.keys(btcPairData)[0] ?? ""
    const btcPrice = btcPairData[btcPairKey]?.c?.[0] ? parseFloat(btcPairData[btcPairKey].c[0]) : null

    // Yahoo: meta.regularMarketPrice = current price, meta.previousClose = prev close
    const cyphMeta = cyphQuote?.chart?.result?.[0]?.meta ?? {}
    const cyphPrice: number | null = cyphMeta.regularMarketPrice ?? null
    const cyphPrevClose: number | null = cyphMeta.previousClose ?? cyphMeta.chartPreviousClose ?? null

    const stats = computeStats(fullHistory, cyphPrice, zecPrice)
    // Surface the 24h % change from the stats block at the top level so
    // the existing UI keeps working. ZEC's 24h was previously computed
    // against Kraken's `o` field (today's UTC open, not 24h ago) which
    // gave wildly wrong values right after midnight UTC — the stats
    // version walks 1 calendar day back through the daily history, which
    // is what the user actually expects.
    const zecChange24h = stats.zec.change24h
    const cyphChange24h = stats.cyph.change24h ?? (
      cyphPrice != null && cyphPrevClose != null && cyphPrevClose > 0
        ? ((cyphPrice - cyphPrevClose) / cyphPrevClose) * 100
        : null
    )

    return NextResponse.json({
      history,
      current: {
        cyph: { price: cyphPrice, change24h: cyphChange24h },
        zec: { price: zecPrice, change24h: zecChange24h },
        btc: { price: btcPrice, change24h: pctFromHistory(fullHistory, "btc", btcPrice) },
      },
      stats,
    })
  } catch (err) {
    console.error("[v0] Price API error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
