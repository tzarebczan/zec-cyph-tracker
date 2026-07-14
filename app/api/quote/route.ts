import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

const QUOTE_KV_KEY = "cyph.quote.lastKnown.v1"

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
// 3. v8/finance/chart — anonymous and independent of the crumb session. Its
//    one-minute candles include pre/post-market trades, so it can enrich a
//    lagging v7 response and keep the dashboard live if v7 is unavailable.
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
  // Calendar fields — Yahoo emits the next scheduled earnings call as a
  // unix timestamp, plus a flag indicating whether the date is exact or
  // an estimate from the Whisper Number-style date range.
  "earningsTimestamp",
  "earningsTimestampStart",
  "earningsTimestampEnd",
  "isEarningsDateEstimate",
  // Needed for NAV per share / mNAV computation on /holdings + the
  // dashboard treasury chip. Yahoo updates this from the most recent
  // 10-Q / 10-K filing so it lags share issuances by a few weeks.
  "sharesOutstanding",
  "marketCap",
  // Session share-volume so the dashboard and /holdings can surface
  // "shares traded since open / after hours" without a separate chart call.
  "regularMarketVolume",
  "preMarketVolume",
  "postMarketVolume",
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
  earningsTimestamp: number | null
  earningsDateEstimate: boolean | null
  sharesOutstanding: number | null
  marketCap: number | null
  regularMarketVolume: number | null
  preMarketVolume: number | null
  postMarketVolume: number | null
}

interface KVLike {
  get(key: string): Promise<string | null>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>
}

async function getKV(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    return (
      (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
    )
  } catch {
    return null
  }
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
      earningsTimestamp: q.earningsTimestamp ?? q.earningsTimestampStart ?? null,
      earningsDateEstimate: q.isEarningsDateEstimate ?? null,
      sharesOutstanding: typeof q.sharesOutstanding === "number" ? q.sharesOutstanding : null,
      marketCap: typeof q.marketCap === "number" ? q.marketCap : null,
      regularMarketVolume: typeof q.regularMarketVolume === "number" ? q.regularMarketVolume : null,
      preMarketVolume: typeof q.preMarketVolume === "number" ? q.preMarketVolume : null,
      postMarketVolume: typeof q.postMarketVolume === "number" ? q.postMarketVolume : null,
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
    // Earnings timestamps + share count aren't in the page DOM in any
    // reliable way; the cache merge in GET() will carry the v7 values
    // forward across these fallback paths.
    earningsTimestamp: null,
    earningsDateEstimate: null,
    sharesOutstanding: null,
    marketCap: null,
    regularMarketVolume: null,
    preMarketVolume: null,
    postMarketVolume: null,
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

async function fetchV8Chart(
  viaProxy: boolean,
  host: "query1" | "query2" = "query1"
): Promise<NormalizedQuote> {
  const yahooUrl =
    `https://${host}.finance.yahoo.com/v8/finance/chart/CYPH` +
    "?interval=1m&range=1d&includePrePost=true"
  // corsproxy.io is the only proxy I tested that reliably forwards a stateless
  // GET to Yahoo. Crumb-based endpoints can't go through it because session
  // cookies don't survive the relay, but v8 chart needs no auth.
  const url = viaProxy
    ? `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`
    : yahooUrl
  // The chart endpoint is anonymous. Supplying the browser-only Origin and
  // Referer headers used by the crumb endpoints causes Yahoo to return 429
  // from some Node/Worker egress paths even when this same URL is available.
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok)
    throw new Error(
      `Yahoo v8 chart ${host}${viaProxy ? " (via corsproxy)" : ""} failed: ${res.status}`
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

  type TradingPeriod = { start?: number; end?: number }
  const tradingPeriods = meta.currentTradingPeriod ?? {}
  const timestamps: unknown[] = Array.isArray(result.timestamp)
    ? result.timestamp
    : []
  const quote = result.indicators?.quote?.[0] ?? {}
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : []
  const volumes: unknown[] = Array.isArray(quote.volume) ? quote.volume : []

  const periodPoint = (period?: TradingPeriod) => {
    const start = Number(period?.start)
    const end = Number(period?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null

    let latest: { price: number; time: number } | null = null
    let volume = 0
    for (let i = 0; i < timestamps.length; i += 1) {
      const rawTime = timestamps[i]
      const rawPrice = closes[i]
      if (typeof rawTime !== "number" || typeof rawPrice !== "number") continue
      const time = rawTime
      const price = rawPrice
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(price) ||
        time < start ||
        time >= end
      ) {
        continue
      }
      if (!latest || time > latest.time) latest = { price, time }
      const pointVolume = volumes[i]
      if (typeof pointVolume === "number" && pointVolume > 0) volume += pointVolume
    }
    return latest ? { ...latest, volume: volume > 0 ? volume : null } : null
  }

  const pre = periodPoint(tradingPeriods.pre)
  const post = periodPoint(tradingPeriods.post)
  const extendedChange = (price: number | undefined) =>
    price != null && regularPrice != null ? price - regularPrice : null
  const extendedChangePct = (price: number | undefined) =>
    price != null && regularPrice != null && regularPrice > 0
      ? ((price - regularPrice) / regularPrice) * 100
      : null
  const nowSec = Math.floor(Date.now() / 1000)
  const inPeriod = (period?: TradingPeriod) => {
    const start = Number(period?.start)
    const end = Number(period?.end)
    return Number.isFinite(start) && Number.isFinite(end) && nowSec >= start && nowSec < end
  }
  const inferredMarketState = inPeriod(tradingPeriods.pre)
    ? "PRE"
    : inPeriod(tradingPeriods.regular)
      ? "REGULAR"
      : inPeriod(tradingPeriods.post)
        ? "POST"
        : meta.marketState ?? "CLOSED"

  return {
    symbol: meta.symbol ?? "CYPH",
    shortName: "Cypherpunk Holdings",
    currency: meta.currency ?? "USD",
    marketState: inferredMarketState,
    regularMarketPrice: regularPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    regularMarketPreviousClose: prevClose,
    regularMarketTime: meta.regularMarketTime ?? null,
    preMarketPrice: pre?.price ?? null,
    preMarketChange: extendedChange(pre?.price),
    preMarketChangePercent: extendedChangePct(pre?.price),
    preMarketTime: pre?.time ?? null,
    postMarketPrice: post?.price ?? null,
    postMarketChange: extendedChange(post?.price),
    postMarketChangePercent: extendedChangePct(post?.price),
    postMarketTime: post?.time ?? null,
    overnightMarketPrice: null,
    overnightMarketChange: null,
    overnightMarketChangePercent: null,
    overnightMarketTime: null,
    earningsTimestamp: null,
    earningsDateEstimate: null,
    sharesOutstanding: null,
    marketCap: null,
    regularMarketVolume: null,
    preMarketVolume: pre?.volume ?? null,
    postMarketVolume: post?.volume ?? null,
  }
}

// Per-instance cache. Yahoo rate-limits Vercel egress, so we share one upstream
// fetch across every client refresh. SWR refreshes ~30 s, multiple users can
// share the same Lambda — without this cache they all stampede Yahoo.
type CachedQuote = { data: NormalizedQuote; fetchedAt: number; source: string }
let lastSuccess: CachedQuote | null = null
let blockedUntil = 0 // unix-ms; respect 429 backoff

const FRESH_TTL_MS = 30_000 // serve cache without re-fetching for 30 s
const FRESH_REGULAR_TICK_MS = 20 * 60_000
// Tolerate up to 6 hours of stale data on full upstream failure. Better to
// show a slightly old price labeled "Cached" than a dead retry button. The
// CYPH regular session only moves once per day at close anyway, so a stale
// extended-hours quote is still useful while Yahoo is down.
const STALE_TTL_MS = 6 * 60 * 60_000
const KV_QUOTE_TTL_SECONDS = 7 * 24 * 60 * 60
const RATE_LIMIT_BACKOFF_MS = 90_000 // back off 90 s after a 429
const ACTIVE_EXTENDED_TICK_MS = 2 * 60_000
const V8_ENRICH_TTL_MS = 45_000
let v8EnrichmentCache: { data: NormalizedQuote; fetchedAt: number } | null = null

// Preserve last-seen pre/post/overnight prices for up to 72 h. Yahoo strips
// extended-hours fields from the v7 response once a session is far enough in
// the past — but the user still wants to see e.g. the last overnight tick on
// Saturday morning. We carry forward whatever we last received as long as
// it's recent enough, with the original timestamp so the UI can show
// "as of 12:43 AM EDT". 72 h covers a Friday-to-Monday weekend.
const EXTENDED_CARRY_TTL_MS = 72 * 60 * 60_000

function isRegularTradingWindowEt(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  const weekday = get("weekday")
  if (weekday === "Sat" || weekday === "Sun") return false
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const minutes = hour * 60 + minute
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

function activeExtendedTradingWindowEt(
  now = new Date()
): "pre" | "post" | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  const weekday = get("weekday")
  if (weekday === "Sat" || weekday === "Sun") return null
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const minutes = hour * 60 + minute
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre"
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post"
  return null
}

function needsExtendedChartEnrichment(q: NormalizedQuote): boolean {
  const session = activeExtendedTradingWindowEt()
  if (!session) return false
  const price = session === "pre" ? q.preMarketPrice : q.postMarketPrice
  const time = session === "pre" ? q.preMarketTime : q.postMarketTime
  if (price == null || time == null) return true
  return Date.now() - time * 1000 >= ACTIVE_EXTENDED_TICK_MS
}

function hasFreshRegularTick(q: NormalizedQuote): boolean {
  if (q.regularMarketPrice == null || q.regularMarketTime == null) return false
  const ageMs = Date.now() - q.regularMarketTime * 1000
  return ageMs >= -60_000 && ageMs < FRESH_REGULAR_TICK_MS
}

function normalizeActiveRegularSession(q: NormalizedQuote): NormalizedQuote {
  if (!isRegularTradingWindowEt() || !hasFreshRegularTick(q)) return q
  return {
    ...q,
    marketState: "REGULAR",
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

/**
 * Merge fresh fetched data with the previous cached response so extended-hours
 * fields persist when Yahoo drops them.
 *
 * Per session (pre / post / overnight):
 *  - Use the cached value when fresh has dropped it (price is null) AND
 *    the cached timestamp is within EXTENDED_CARRY_TTL_MS.
 *  - Use the cached value when both have a value but cached's timestamp
 *    is more recent (rare, but safe).
 *  - Otherwise use the fresh value.
 */
function preserveExtendedFromCache(
  fresh: NormalizedQuote,
  cached: NormalizedQuote | null
): NormalizedQuote {
  if (!cached) return fresh
  const out = { ...fresh }
  const nowMs = Date.now()
  const sessions = ["pre", "post", "overnight"] as const
  for (const s of sessions) {
    const priceK = `${s}MarketPrice` as const
    const timeK = `${s}MarketTime` as const
    const changeK = `${s}MarketChange` as const
    const pctK = `${s}MarketChangePercent` as const

    const cachedPrice = cached[priceK]
    const cachedTime = cached[timeK]
    if (cachedPrice == null || cachedTime == null) continue
    if (nowMs - cachedTime * 1000 > EXTENDED_CARRY_TTL_MS) continue

    const freshPrice = fresh[priceK]
    const freshTime = fresh[timeK]
    const cachedIsNewer =
      freshTime == null || cachedTime > (freshTime as number)
    const freshDropped = freshPrice == null

    if (freshDropped || cachedIsNewer) {
      ;(out as Record<string, unknown>)[priceK] = cachedPrice
      ;(out as Record<string, unknown>)[timeK] = cachedTime
      ;(out as Record<string, unknown>)[changeK] = cached[changeK]
      ;(out as Record<string, unknown>)[pctK] = cached[pctK]
    }
  }
  // Earnings: if the fresh path is the page-scrape / v8 fallback (which
  // doesn't include earnings) but the cache has it from an earlier v7
  // fetch, carry it forward — so long as the date hasn't already passed
  // by more than a day.
  if (out.earningsTimestamp == null && cached.earningsTimestamp != null) {
    const stillRelevant =
      nowMs - cached.earningsTimestamp * 1000 < 86400_000
    if (stillRelevant) {
      out.earningsTimestamp = cached.earningsTimestamp
      out.earningsDateEstimate = cached.earningsDateEstimate
    }
  }
  // Shares outstanding / market cap come only from v7 — fallback paths
  // (page scrape, v8 chart) leave them null. Carry the cached values
  // forward so the dashboard treasury chip's NAV and the /holdings
  // page's NAV computation keep working through brief v7 outages.
  if (out.sharesOutstanding == null && cached.sharesOutstanding != null) {
    out.sharesOutstanding = cached.sharesOutstanding
  }
  if (out.marketCap == null) {
    out.marketCap =
      out.sharesOutstanding != null && out.regularMarketPrice != null
        ? out.sharesOutstanding * out.regularMarketPrice
        : cached.marketCap
  }
  // Session volume only comes from v7. Carry it forward through fallback
  // paths so the dashboard's "shares traded" tile doesn't blank out.
  if (out.regularMarketVolume == null && cached.regularMarketVolume != null) {
    out.regularMarketVolume = cached.regularMarketVolume
  }
  if (out.preMarketVolume == null && cached.preMarketVolume != null) {
    out.preMarketVolume = cached.preMarketVolume
  }
  if (out.postMarketVolume == null && cached.postMarketVolume != null) {
    out.postMarketVolume = cached.postMarketVolume
  }
  return out
}

async function enrichActiveExtendedSession(
  fresh: NormalizedQuote
): Promise<{ data: NormalizedQuote; enriched: boolean }> {
  if (!needsExtendedChartEnrichment(fresh)) {
    return { data: fresh, enriched: false }
  }

  const now = Date.now()
  let chart =
    v8EnrichmentCache && now - v8EnrichmentCache.fetchedAt < V8_ENRICH_TTL_MS
      ? v8EnrichmentCache.data
      : null
  if (!chart) {
    try {
      chart = await fetchV8Chart(false, "query1")
    } catch {
      chart = await fetchV8Chart(false, "query2")
    }
    v8EnrichmentCache = { data: chart, fetchedAt: Date.now() }
  }

  const session = activeExtendedTradingWindowEt()
  if (!session) return { data: fresh, enriched: false }
  const freshTime = session === "pre" ? fresh.preMarketTime : fresh.postMarketTime
  const chartTime = session === "pre" ? chart.preMarketTime : chart.postMarketTime
  if (chartTime == null || (freshTime != null && chartTime <= freshTime)) {
    return { data: fresh, enriched: false }
  }

  const data = preserveExtendedFromCache(fresh, chart)
  data.marketState = session === "pre" ? "PRE" : "POST"
  return { data, enriched: true }
}

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

function parseCachedQuote(raw: string | null): CachedQuote | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedQuote
    if (
      !parsed ||
      !parsed.data ||
      typeof parsed.fetchedAt !== "number" ||
      typeof parsed.source !== "string"
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function readKvQuote(kv: KVLike | null): Promise<CachedQuote | null> {
  if (!kv) return null
  try {
    return parseCachedQuote(await kv.get(QUOTE_KV_KEY))
  } catch {
    return null
  }
}

function writeKvQuote(kv: KVLike | null, quote: CachedQuote) {
  if (!kv) return
  kv
    .put(QUOTE_KV_KEY, JSON.stringify(quote), {
      expirationTtl: KV_QUOTE_TTL_SECONDS,
    })
    .catch(() => {
      /* Best effort only; the in-memory response remains valid. */
    })
}

export async function GET() {
  const now = Date.now()
  const kv = await getKV()
  const kvQuote = lastSuccess ? null : await readKvQuote(kv)
  if (!lastSuccess && kvQuote) {
    lastSuccess = {
      ...kvQuote,
      data: normalizeActiveRegularSession(kvQuote.data),
    }
  }

  // Fast path: serve fresh cache without touching Yahoo.
  if (lastSuccess && now - lastSuccess.fetchedAt < FRESH_TTL_MS) {
    lastSuccess = {
      ...lastSuccess,
      data: normalizeActiveRegularSession(lastSuccess.data),
    }
    return NextResponse.json(withMeta(lastSuccess.data, lastSuccess, false))
  }

  // Backoff path: if Yahoo recently 429'd us, don't hammer them. Serve stale
  // cache if we have any, else surface the rate-limit error.
  if (now < blockedUntil) {
    if (lastSuccess && now - lastSuccess.fetchedAt < STALE_TTL_MS) {
      lastSuccess = {
        ...lastSuccess,
        data: normalizeActiveRegularSession(lastSuccess.data),
      }
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
    ["v8-chart-query1", () => fetchV8Chart(false, "query1")],
    ["v8-chart-query2", () => fetchV8Chart(false, "query2")],
    ["v8-chart-via-proxy", () => fetchV8Chart(true, "query1")],
  ] as const) {
    try {
      let fresh = await fn()
      let source = name as string
      if (fresh.regularMarketPrice == null) {
        errors.push(`${name}: regularMarketPrice missing`)
        continue
      }
      if (!name.startsWith("v8-chart")) {
        try {
          const enriched = await enrichActiveExtendedSession(fresh)
          fresh = enriched.data
          if (enriched.enriched) source += "+v8-extended"
        } catch (err) {
          console.warn(
            "[v0] Quote API: v8 extended-hours enrichment unavailable:",
            err instanceof Error ? err.message : String(err)
          )
        }
      }
      // Carry forward extended-hours prices the previous response had, so
      // the UI can show e.g. last night's overnight tick on a Saturday
      // morning even if Yahoo has stopped including it in the response.
      const data = normalizeActiveRegularSession(
        preserveExtendedFromCache(fresh, lastSuccess?.data ?? null)
      )
      lastSuccess = { data, fetchedAt: Date.now(), source }
      writeKvQuote(kv, lastSuccess)
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
    lastSuccess = {
      ...lastSuccess,
      data: normalizeActiveRegularSession(lastSuccess.data),
    }
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
