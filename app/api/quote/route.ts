import { NextResponse } from "next/server"

// Three sources, tried in order:
//
// 1. v7/finance/quote with `overnightPrice=true` — Yahoo's website uses this
//    same call. It returns regular + pre + post + OVERNIGHT (Blue Ocean ATS,
//    8 PM – 4 AM ET) in one response, but is gated behind a crumb token.
//
// 2. Scrape https://finance.yahoo.com/quote/CYPH/ — same data lives in the
//    server-rendered HTML under `qsp-price` / `qsp-overnight-price` selectors.
//    Used as a fallback in case Yahoo blocks the API from this egress IP but
//    not the public page.
//
// 3. v8/finance/chart — anonymous, has only the regular session, used as a
//    last resort so the dashboard never goes blank.
const QUOTE_FIELDS = [
  "regularMarketPrice",
  "regularMarketChange",
  "regularMarketChangePercent",
  "regularMarketPreviousClose",
  "regularMarketTime",
  "preMarketPrice",
  "preMarketChange",
  "preMarketChangePercent",
  "preMarketTime",
  "postMarketPrice",
  "postMarketChange",
  "postMarketChangePercent",
  "postMarketTime",
  "overnightMarketPrice",
  "overnightMarketChange",
  "overnightMarketChangePercent",
  "overnightMarketTime",
  "marketState",
  "shortName",
  "longName",
  "currency",
].join(",")

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://finance.yahoo.com",
  Referer: "https://finance.yahoo.com/quote/CYPH/",
}

interface NormalizedQuote {
  symbol: string
  shortName: string
  currency: string
  marketState: string
  regularMarketPrice: number | null
  regularMarketChange: number | null
  regularMarketChangePercent: number | null
  regularMarketPreviousClose: number | null
  regularMarketTime: number | null
  preMarketPrice: number | null
  preMarketChange: number | null
  preMarketChangePercent: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketChange: number | null
  postMarketChangePercent: number | null
  postMarketTime: number | null
  overnightMarketPrice: number | null
  overnightMarketChange: number | null
  overnightMarketChangePercent: number | null
  overnightMarketTime: number | null
}

type YahooSession = { cookie: string; crumb: string; expires: number }
let cachedSession: YahooSession | null = null

async function getYahooSession(force = false): Promise<YahooSession> {
  if (!force && cachedSession && Date.now() < cachedSession.expires) {
    return cachedSession
  }

  // fc.yahoo.com responds 404 but sets the session cookies we need.
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: HEADERS,
    redirect: "manual",
    cache: "no-store",
  })
  const setCookies = cookieRes.headers.getSetCookie?.() ?? []
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ")
  if (!cookie) throw new Error("Failed to obtain Yahoo session cookie")

  const crumbRes = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { ...HEADERS, Cookie: cookie },
      cache: "no-store",
    }
  )
  if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch failed: ${crumbRes.status}`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb) throw new Error("Yahoo returned empty crumb")

  cachedSession = { cookie, crumb, expires: Date.now() + 25 * 60_000 }
  return cachedSession
}

async function fetchV7Quote(): Promise<NormalizedQuote> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getYahooSession(attempt > 0)
    const url =
      `https://query1.finance.yahoo.com/v7/finance/quote` +
      `?symbols=CYPH&fields=${QUOTE_FIELDS}` +
      `&enablePrivateCompany=true&overnightPrice=true` +
      `&crumb=${encodeURIComponent(session.crumb)}`

    const res = await fetch(url, {
      headers: { ...HEADERS, Cookie: session.cookie },
      cache: "no-store",
    })

    if (res.status === 401 || res.status === 403) {
      cachedSession = null
      lastErr = new Error(`Yahoo v7 auth rejected: ${res.status}`)
      continue
    }
    if (!res.ok) throw new Error(`Yahoo v7 quote failed: ${res.status}`)

    const json = await res.json()
    const q = json?.quoteResponse?.result?.[0]
    const apiErr = json?.quoteResponse?.error
    if (!q) {
      throw new Error(
        `Yahoo v7 quote: no result (${apiErr ? JSON.stringify(apiErr) : "empty"})`
      )
    }

    return {
      symbol: q.symbol ?? "CYPH",
      shortName: q.shortName ?? q.longName ?? "Cypherpunk Holdings",
      currency: q.currency ?? "USD",
      marketState: q.marketState ?? "CLOSED",
      regularMarketPrice: q.regularMarketPrice ?? null,
      regularMarketChange: q.regularMarketChange ?? null,
      regularMarketChangePercent: q.regularMarketChangePercent ?? null,
      regularMarketPreviousClose: q.regularMarketPreviousClose ?? null,
      regularMarketTime: q.regularMarketTime ?? null,
      preMarketPrice: q.preMarketPrice ?? null,
      preMarketChange: q.preMarketChange ?? null,
      preMarketChangePercent: q.preMarketChangePercent ?? null,
      preMarketTime: q.preMarketTime ?? null,
      postMarketPrice: q.postMarketPrice ?? null,
      postMarketChange: q.postMarketChange ?? null,
      postMarketChangePercent: q.postMarketChangePercent ?? null,
      postMarketTime: q.postMarketTime ?? null,
      overnightMarketPrice: q.overnightMarketPrice ?? null,
      overnightMarketChange: q.overnightMarketChange ?? null,
      overnightMarketChangePercent: q.overnightMarketChangePercent ?? null,
      overnightMarketTime: q.overnightMarketTime ?? null,
    }
  }
  throw lastErr ?? new Error("Yahoo v7 quote: auth retries exhausted")
}

/** Match a value out of `data-testid="<id>">…<` (one occurrence). */
function matchTestid(html: string, id: string): string | null {
  const re = new RegExp(`data-testid="${id}"[^>]*>([^<]{1,80})`)
  const m = html.match(re)
  return m ? m[1].trim() : null
}

/** Match a value out of `class="<cls>">…<` (one occurrence). */
function matchClass(html: string, cls: string): string | null {
  const re = new RegExp(`"${cls}">([^<]{1,80})`)
  const m = html.match(re)
  return m ? m[1].trim() : null
}

/** "+0.0842" / "+9.47%" / "(+9.47%)" / "—" → numeric or null. */
function toNum(raw: string | null): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[(),%\s+]/g, "")
  if (!cleaned || cleaned === "—" || cleaned === "-") return null
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

async function fetchYahooPageScrape(): Promise<NormalizedQuote> {
  const session = await getYahooSession()
  const res = await fetch("https://finance.yahoo.com/quote/CYPH/", {
    headers: { ...HEADERS, Cookie: session.cookie },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Yahoo page scrape failed: ${res.status}`)
  const html = await res.text()

  const regularPrice = toNum(matchTestid(html, "qsp-price"))
  const regularChange = toNum(matchTestid(html, "qsp-price-change"))
  const regularChangePct = toNum(matchTestid(html, "qsp-price-change-percent"))

  const overnightPrice = toNum(matchClass(html, "qsp-overnight-price"))
  const overnightChange = toNum(matchClass(html, "qsp-overnight-price-change"))
  const overnightChangePct = toNum(
    matchClass(html, "qsp-overnight-price-change-percent")
  )

  // Page renders "Overnight: 12:43:22 AM EDT" — parse to a unix-seconds best-effort.
  const overnightTimeMatch = html.match(
    /Overnight:\s*(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)\s*[A-Z]{2,4})/
  )
  const overnightTime = overnightTimeMatch ? parseEdtClockToUnix(overnightTimeMatch[1]) : null

  if (regularPrice == null) {
    throw new Error("Yahoo page scrape: could not parse regular price")
  }

  // Page doesn't easily expose previous close as a parseable field, so derive
  // it from change if both are present.
  const prevClose =
    regularPrice != null && regularChange != null
      ? regularPrice - regularChange
      : null

  return {
    symbol: "CYPH",
    shortName: "Cypherpunk Holdings",
    currency: "USD",
    marketState: overnightPrice != null ? "OVERNIGHT" : "CLOSED",
    regularMarketPrice: regularPrice,
    regularMarketChange: regularChange,
    regularMarketChangePercent: regularChangePct,
    regularMarketPreviousClose: prevClose,
    regularMarketTime: null,
    preMarketPrice: null,
    preMarketChange: null,
    preMarketChangePercent: null,
    preMarketTime: null,
    postMarketPrice: null,
    postMarketChange: null,
    postMarketChangePercent: null,
    postMarketTime: null,
    overnightMarketPrice: overnightPrice,
    overnightMarketChange: overnightChange,
    overnightMarketChangePercent: overnightChangePct,
    overnightMarketTime: overnightTime,
  }
}

/** "12:43:22 AM EDT" → unix seconds, treating it as today in America/New_York. */
function parseEdtClockToUnix(clock: string): number | null {
  const m = clock.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = parseInt(m[2], 10)
  const second = parseInt(m[3], 10)
  const ampm = m[4].toUpperCase()
  if (ampm === "PM" && hour !== 12) hour += 12
  if (ampm === "AM" && hour === 12) hour = 0

  // Use the server's "now in ET" date so AM/PM the page emits maps to today.
  const nowEt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  )
  // Detect whether ET is currently DST (EDT = UTC-4) or standard (EST = UTC-5).
  const jan = new Date(nowEt.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(nowEt.getFullYear(), 6, 1).getTimezoneOffset()
  const isDst = nowEt.getTimezoneOffset() < Math.max(jan, jul)
  const offsetHours = isDst ? 4 : 5
  const utcHour = hour + offsetHours

  const ts = Date.UTC(
    nowEt.getFullYear(),
    nowEt.getMonth(),
    nowEt.getDate(),
    utcHour,
    minute,
    second
  )
  return Math.floor(ts / 1000)
}

async function fetchV8Chart(viaProxy: boolean): Promise<NormalizedQuote> {
  const yahooUrl =
    "https://query1.finance.yahoo.com/v8/finance/chart/CYPH?interval=1m&range=1d&includePrePost=true"
  // corsproxy.io is the only proxy I tested that reliably forwards a stateless
  // GET to Yahoo. Crumb-based endpoints can't go through it because session
  // cookies don't survive the relay, but v8 chart needs no auth.
  const url = viaProxy
    ? `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`
    : yahooUrl
  const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
  if (!res.ok)
    throw new Error(
      `Yahoo v8 chart${viaProxy ? " (via corsproxy)" : ""} failed: ${res.status}`
    )
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error("Yahoo v8 chart: empty result")

  const meta = result.meta ?? {}
  const regularPrice: number | null = meta.regularMarketPrice ?? null
  const prevClose: number | null =
    meta.chartPreviousClose ?? meta.previousClose ?? null
  const change =
    regularPrice != null && prevClose != null ? regularPrice - prevClose : null
  const changePct =
    regularPrice != null && prevClose != null && prevClose > 0
      ? ((regularPrice - prevClose) / prevClose) * 100
      : null

  return {
    symbol: meta.symbol ?? "CYPH",
    shortName: "Cypherpunk Holdings",
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? "CLOSED",
    regularMarketPrice: regularPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    regularMarketPreviousClose: prevClose,
    regularMarketTime: meta.regularMarketTime ?? null,
    preMarketPrice: null,
    preMarketChange: null,
    preMarketChangePercent: null,
    preMarketTime: null,
    postMarketPrice: null,
    postMarketChange: null,
    postMarketChangePercent: null,
    postMarketTime: null,
    overnightMarketPrice: null,
    overnightMarketChange: null,
    overnightMarketChangePercent: null,
    overnightMarketTime: null,
  }
}

// Per-instance cache. Yahoo rate-limits Vercel egress, so we share one upstream
// fetch across every client refresh. SWR refreshes ~30 s, multiple users can
// share the same Lambda — without this cache they all stampede Yahoo.
type CachedQuote = { data: NormalizedQuote; fetchedAt: number; source: string }
let lastSuccess: CachedQuote | null = null
let blockedUntil = 0 // unix-ms; respect 429 backoff

const FRESH_TTL_MS = 30_000 // serve cache without re-fetching for 30 s
// Tolerate up to 6 hours of stale data on full upstream failure. Better to
// show a slightly old price labeled "Cached" than a dead retry button. The
// CYPH regular session only moves once per day at close anyway, so a stale
// extended-hours quote is still useful while Yahoo is down.
const STALE_TTL_MS = 6 * 60 * 60_000
const RATE_LIMIT_BACKOFF_MS = 90_000 // back off 90 s after a 429

function withMeta(
  data: NormalizedQuote,
  cached: CachedQuote,
  stale: boolean
) {
  return {
    ...data,
    _cachedAtSec: Math.floor(cached.fetchedAt / 1000),
    _ageSec: Math.floor((Date.now() - cached.fetchedAt) / 1000),
    _source: cached.source,
    _stale: stale,
  }
}

export async function GET() {
  const now = Date.now()

  // Fast path: serve fresh cache without touching Yahoo.
  if (lastSuccess && now - lastSuccess.fetchedAt < FRESH_TTL_MS) {
    return NextResponse.json(withMeta(lastSuccess.data, lastSuccess, false))
  }

  // Backoff path: if Yahoo recently 429'd us, don't hammer them. Serve stale
  // cache if we have any, else surface the rate-limit error.
  if (now < blockedUntil) {
    if (lastSuccess && now - lastSuccess.fetchedAt < STALE_TTL_MS) {
      return NextResponse.json(withMeta(lastSuccess.data, lastSuccess, true))
    }
    return NextResponse.json(
      {
        error: "Yahoo Finance rate-limited; no cached data available yet.",
        retryAfterSec: Math.ceil((blockedUntil - now) / 1000),
      },
      { status: 503, headers: { "Retry-After": String(Math.ceil((blockedUntil - now) / 1000)) } }
    )
  }

  const errors: string[] = []
  let saw429 = false
  // Order: prefer sources with overnight data first; corsproxy fallback last
  // because it relies on a third-party relay (slower, no overnight, but
  // bypasses Yahoo IP blocks).
  for (const [name, fn] of [
    ["v7-quote", fetchV7Quote],
    ["page-scrape", fetchYahooPageScrape],
    ["v8-chart-direct", () => fetchV8Chart(false)],
    ["v8-chart-via-proxy", () => fetchV8Chart(true)],
  ] as const) {
    try {
      const data = await fn()
      if (data.regularMarketPrice == null) {
        errors.push(`${name}: regularMarketPrice missing`)
        continue
      }
      lastSuccess = { data, fetchedAt: Date.now(), source: name }
      return NextResponse.json(withMeta(data, lastSuccess, false))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${name}: ${msg}`)
      if (msg.includes("429")) saw429 = true
    }
  }

  // All sources failed. Set rate-limit backoff if any source said 429, and
  // serve stale cache if we have anything recent enough — better stale data
  // than no data.
  if (saw429) {
    blockedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
    cachedSession = null // crumb may itself be poisoned; force a fresh handshake next time
  }

  if (lastSuccess && Date.now() - lastSuccess.fetchedAt < STALE_TTL_MS) {
    console.warn("[v0] Quote API: serving stale cache, all sources failed:", errors)
    return NextResponse.json(withMeta(lastSuccess.data, lastSuccess, true))
  }

  console.error("[v0] Quote API: all sources failed:", errors)
  return NextResponse.json(
    {
      error: errors.join(" | ") || "All quote sources failed",
      retryAfterSec: saw429 ? Math.ceil(RATE_LIMIT_BACKOFF_MS / 1000) : undefined,
    },
    {
      status: saw429 ? 503 : 500,
      headers: saw429
        ? { "Retry-After": String(Math.ceil(RATE_LIMIT_BACKOFF_MS / 1000)) }
        : undefined,
    }
  )
}
