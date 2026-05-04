import { NextResponse } from "next/server"

// Yahoo Finance "v7 quote" returns regular + pre + post + overnight (Blue Ocean ATS)
// data in a single response, but as of 2024 it's gated behind a crumb token tied
// to a session cookie. We do the cookie+crumb handshake on the server, cache the
// result, and fall back to the open v8 chart endpoint if the handshake fails so
// the dashboard always has at least the regular-session price.
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
  "marketState",
  "shortName",
  "longName",
  "currency",
].join(",")

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
}

type YahooAuth = { cookie: string; crumb: string; expires: number }
let cachedAuth: YahooAuth | null = null

async function getYahooAuth(force = false): Promise<YahooAuth> {
  if (!force && cachedAuth && Date.now() < cachedAuth.expires) return cachedAuth

  // fc.yahoo.com responds 404 but still sets the session cookies we need.
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

  cachedAuth = { cookie, crumb, expires: Date.now() + 25 * 60_000 }
  return cachedAuth
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
}

async function fetchV7Quote(): Promise<NormalizedQuote> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getYahooAuth(attempt > 0)
    const url =
      `https://query1.finance.yahoo.com/v7/finance/quote` +
      `?symbols=CYPH&fields=${QUOTE_FIELDS}` +
      `&crumb=${encodeURIComponent(auth.crumb)}`

    const res = await fetch(url, {
      headers: { ...HEADERS, Cookie: auth.cookie },
      cache: "no-store",
    })

    if (res.status === 401 || res.status === 403) {
      cachedAuth = null
      lastErr = new Error(`Yahoo auth rejected: ${res.status}`)
      continue
    }
    if (!res.ok) throw new Error(`Yahoo v7 quote failed: ${res.status}`)

    const json = await res.json()
    const q = json?.quoteResponse?.result?.[0]
    const apiErr = json?.quoteResponse?.error
    if (!q) throw new Error(`Yahoo v7 quote: no result (${apiErr ? JSON.stringify(apiErr) : "empty"})`)

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
    }
  }
  throw lastErr ?? new Error("Yahoo v7 quote: auth retries exhausted")
}

/**
 * Fallback: v8 chart endpoint requires no auth but only exposes regular-session
 * data. Used only if the v7 handshake breaks so the dashboard never goes blank.
 */
async function fetchV8ChartFallback(): Promise<NormalizedQuote> {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/CYPH?interval=1m&range=1d&includePrePost=true"
  const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
  if (!res.ok) throw new Error(`Yahoo v8 chart failed: ${res.status}`)
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
  }
}

export async function GET() {
  try {
    return NextResponse.json(await fetchV7Quote())
  } catch (e1) {
    console.warn("[v0] Yahoo v7 quote failed, falling back to v8 chart:", e1)
    try {
      return NextResponse.json(await fetchV8ChartFallback())
    } catch (e2) {
      console.error("[v0] Both quote endpoints failed:", e2)
      return NextResponse.json({ error: String(e2) }, { status: 500 })
    }
  }
}
