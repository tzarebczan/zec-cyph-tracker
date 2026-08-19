// Yahoo Finance crumb/cookie handshake, shared by every route that needs a
// gated Yahoo endpoint (/api/quote's v7 quote, /api/cyph-analysts'
// quoteSummary). Kept in one place so the crumb cache is shared too — Yahoo
// rate-limits the handshake harder than the data endpoints, so two routes each
// running their own would double our 429 exposure for no benefit.

export const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://finance.yahoo.com",
  Referer: "https://finance.yahoo.com/quote/CYPH/",
}

/** The handshake endpoints must NOT receive Origin/Referer. Supplying the
 *  browser-only headers that the data endpoints want makes fc.yahoo.com and
 *  getcrumb return 429 from Node/Worker egress — the same trap already
 *  documented for the v8 chart endpoint, which had been fixed there but not
 *  here, so every crumb-gated caller (v7 quotes, the ticker) was intermittently
 *  locked out with "Yahoo crumb fetch failed: 429". */
const HANDSHAKE_HEADERS = {
  "User-Agent": YAHOO_HEADERS["User-Agent"],
  Accept: "*/*",
}

export type YahooSession = { cookie: string; crumb: string; expires: number }

let cachedSession: YahooSession | null = null

export async function getYahooSession(force = false): Promise<YahooSession> {
  if (!force && cachedSession && Date.now() < cachedSession.expires) {
    return cachedSession
  }

  // fc.yahoo.com responds 404 but sets the session cookies we need.
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: HANDSHAKE_HEADERS,
    redirect: "manual",
    cache: "no-store",
  })
  const setCookies = cookieRes.headers.getSetCookie?.() ?? []
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ")
  if (!cookie) throw new Error("Failed to obtain Yahoo session cookie")

  const crumbRes = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { ...HANDSHAKE_HEADERS, Cookie: cookie },
      cache: "no-store",
    }
  )
  if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch failed: ${crumbRes.status}`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb) throw new Error("Yahoo returned empty crumb")

  cachedSession = { cookie, crumb, expires: Date.now() + 25 * 60_000 }
  return cachedSession
}

/** Drop the cached crumb. Call when a gated endpoint 401/403s — the crumb
 *  itself may be poisoned, so the next call should re-handshake. */
export function clearYahooSession() {
  cachedSession = null
}
