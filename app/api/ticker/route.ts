import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Multi-symbol Yahoo Finance aggregator for the beta ticker tape.
//
// One v7/finance/quote call returns price + previousClose + change% for
// the entire symbol set; the ticker renders 8 chips today but we keep
// the symbol map open-ended so adding a new chip is a one-line change.
//
// Cache layout matches the rest of the API surfaces:
//   • SUPPLY_CACHE KV with a 60s fresh TTL — fits the user-visible
//     refresh cadence on the ticker without hammering Yahoo from every
//     /beta page-load.
//   • Long-lived stale mirror, no TTL, written on every successful
//     fetch. Serve last-known-good rather than blank chips when Yahoo
//     blocks or 429s.
//   • Per-instance in-memory cache (FRESH_TTL_MS) so a Lambda that
//     serves multiple requests in the same warm window doesn't even
//     hit KV — matches /api/quote's pattern.

interface ChipQuote {
  /** Chip key shared with `TICKER_CHIP_KEYS` so the client maps 1-1. */
  key: string
  /** Display symbol — separate from the chip key because Yahoo's
   *  symbols (e.g. `^GSPC`, `GC=F`) aren't user-friendly. */
  symbol: string
  /** Formatted price string ready to render. Computed server-side so
   *  the client doesn't ship per-chip number formatters. */
  value: string
  /** 24h percent change. Null when Yahoo dropped previousClose. */
  change: number | null
  /** Optional sub-label (e.g. "vol" for VIX). */
  sub?: string
}

interface TickerResponse {
  chips: ChipQuote[]
  fetchedAt: number
  source: string
  stale?: boolean
}

// Chip → { yahoo symbol, display symbol, optional sub-label, formatter }.
// Order matches the rendered strip order in `TICKER_CHIP_KEYS` so the
// response keeps the chips in a stable position regardless of what
// Yahoo's reply ordering does.
const CHIP_DEFS: {
  key: string
  yahoo: string
  symbol: string
  sub?: string
  // Some symbols need different precision (VIX is two decimals, gold
  // is rounded thousands, indices are commas-no-decimals).
  fmt: (price: number) => string
}[] = [
  // Equity indices.
  {
    key: "spx",
    yahoo: "^GSPC",
    symbol: "S&P",
    sub: "SPX",
    fmt: (p) =>
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  },
  {
    key: "ndx",
    yahoo: "^NDX",
    symbol: "NDX",
    sub: "NASDAQ",
    fmt: (p) =>
      p.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
  },
  {
    key: "dji",
    yahoo: "^DJI",
    symbol: "DJI",
    sub: "DOW",
    fmt: (p) =>
      p.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
  },
  // Crypto-adjacent equities.
  {
    key: "mstr",
    yahoo: "MSTR",
    symbol: "MSTR",
    fmt: (p) =>
      "$" +
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  },
  {
    key: "coin",
    yahoo: "COIN",
    symbol: "COIN",
    fmt: (p) =>
      "$" +
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  },
  // Macro.
  {
    key: "dxy",
    yahoo: "DX-Y.NYB",
    symbol: "DXY",
    fmt: (p) =>
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  },
  {
    key: "gold",
    yahoo: "GC=F",
    symbol: "GOLD",
    fmt: (p) =>
      "$" +
      p.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
  },
  {
    key: "vix",
    yahoo: "^VIX",
    symbol: "VIX",
    sub: "vol",
    fmt: (p) =>
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  },
]

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://finance.yahoo.com",
  Referer: "https://finance.yahoo.com/",
}

const QUOTE_FIELDS = [
  "regularMarketPrice",
  "regularMarketChangePercent",
  "regularMarketPreviousClose",
].join(",")

const KV_KEY = "ticker.v1"
const KV_TTL_SECONDS = 60
const KV_STALE_KEY = "ticker.stale.v1"
const FRESH_TTL_MS = 30_000 // serve in-memory cache without re-fetching for 30 s
const STALE_TTL_MS = 24 * 60 * 60_000

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
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

// Yahoo crumb-session handshake — same pattern as /api/quote. We
// duplicate the helper rather than share it across routes because each
// Lambda has its own warm session; bouncing the crumb across routes
// would require a shared store and 429s on one route would poison the
// other. Cheap to redo here.
type YahooSession = { cookie: string; crumb: string; expires: number }
let cachedSession: YahooSession | null = null

async function getYahooSession(force = false): Promise<YahooSession> {
  if (!force && cachedSession && Date.now() < cachedSession.expires) {
    return cachedSession
  }
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
  if (!crumbRes.ok)
    throw new Error(`Yahoo crumb fetch failed: ${crumbRes.status}`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb) throw new Error("Yahoo returned empty crumb")
  cachedSession = { cookie, crumb, expires: Date.now() + 25 * 60_000 }
  return cachedSession
}

interface YahooQuoteRow {
  symbol?: string
  regularMarketPrice?: number
  regularMarketChangePercent?: number
  regularMarketPreviousClose?: number
}

async function fetchV7Multi(): Promise<ChipQuote[]> {
  const symbols = CHIP_DEFS.map((c) => c.yahoo).join(",")
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getYahooSession(attempt > 0)
    const url =
      `https://query1.finance.yahoo.com/v7/finance/quote` +
      `?symbols=${encodeURIComponent(symbols)}` +
      `&fields=${QUOTE_FIELDS}` +
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
    if (!res.ok) throw new Error(`Yahoo v7 multi-quote failed: ${res.status}`)
    const json = (await res.json()) as {
      quoteResponse?: { result?: YahooQuoteRow[] }
    }
    const rows = json?.quoteResponse?.result ?? []
    return CHIP_DEFS.map((def) => {
      const r = rows.find((row) => row.symbol === def.yahoo)
      if (!r || r.regularMarketPrice == null) return null
      const change =
        r.regularMarketChangePercent != null
          ? r.regularMarketChangePercent
          : r.regularMarketPreviousClose != null &&
              r.regularMarketPreviousClose > 0
            ? ((r.regularMarketPrice - r.regularMarketPreviousClose) /
                r.regularMarketPreviousClose) *
              100
            : null
      const chip: ChipQuote = {
        key: def.key,
        symbol: def.symbol,
        value: def.fmt(r.regularMarketPrice),
        change,
      }
      if (def.sub) chip.sub = def.sub
      return chip
    }).filter((c): c is ChipQuote => c != null)
  }
  throw lastErr ?? new Error("Yahoo v7 multi-quote: auth retries exhausted")
}

interface YahooV8Meta {
  symbol?: string
  regularMarketPrice?: number
  chartPreviousClose?: number
  previousClose?: number
}

// Per-symbol v8 chart fallback. v8 doesn't need a crumb and the
// `corsproxy.io` relay sits in front when our egress is blocked. We
// fire all symbols in parallel so the worst case is roughly 1.5s, not
// 8 × 1.5s = 12s.
async function fetchV8Each(viaProxy = false): Promise<ChipQuote[]> {
  const results = await Promise.all(
    CHIP_DEFS.map(async (def) => {
      const yahooUrl =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.yahoo)}` +
        `?interval=1d&range=2d`
      const url = viaProxy
        ? `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`
        : yahooUrl
      try {
        const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
        if (!res.ok) return null
        const json = (await res.json()) as {
          chart?: { result?: { meta?: YahooV8Meta }[] }
        }
        const meta = json?.chart?.result?.[0]?.meta
        if (!meta || meta.regularMarketPrice == null) return null
        const prev = meta.chartPreviousClose ?? meta.previousClose ?? null
        const change =
          prev != null && prev > 0
            ? ((meta.regularMarketPrice - prev) / prev) * 100
            : null
        const chip: ChipQuote = {
          key: def.key,
          symbol: def.symbol,
          value: def.fmt(meta.regularMarketPrice),
          change,
        }
        if (def.sub) chip.sub = def.sub
        return chip
      } catch {
        return null
      }
    })
  )
  return results.filter((c): c is ChipQuote => c != null)
}

// In-memory cache shared across requests served by the same warm
// Lambda. KV is the canonical store, but reading KV on every refresh
// still costs ~5-10 ms; this skips that for the common "user holding
// /beta with multiple SWR clients" case.
type CachedTicker = { chips: ChipQuote[]; fetchedAt: number; source: string }
let lastSuccess: CachedTicker | null = null
let blockedUntil = 0
const RATE_LIMIT_BACKOFF_MS = 60_000

async function readKvFresh(kv: KVLike): Promise<TickerResponse | null> {
  try {
    const cached = await kv.get(KV_KEY)
    if (!cached) return null
    const parsed = JSON.parse(cached) as TickerResponse
    if (Date.now() - parsed.fetchedAt < KV_TTL_SECONDS * 1000) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function readKvStale(kv: KVLike): Promise<TickerResponse | null> {
  try {
    const cached = await kv.get(KV_STALE_KEY)
    if (!cached) return null
    const parsed = JSON.parse(cached) as TickerResponse
    if (Date.now() - parsed.fetchedAt > STALE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

async function writeKv(kv: KVLike, payload: TickerResponse): Promise<void> {
  // Fresh-cache entry — short TTL, KV expires it automatically.
  await kv
    .put(KV_KEY, JSON.stringify(payload), {
      expirationTtl: KV_TTL_SECONDS,
    })
    .catch(() => {
      /* KV writes are best-effort */
    })
  // Stale mirror — no TTL, overwritten on every success.
  await kv.put(KV_STALE_KEY, JSON.stringify(payload)).catch(() => {
    /* idem */
  })
}

export async function GET() {
  const now = Date.now()

  // In-memory fast path.
  if (lastSuccess && now - lastSuccess.fetchedAt < FRESH_TTL_MS) {
    return NextResponse.json({
      chips: lastSuccess.chips,
      fetchedAt: lastSuccess.fetchedAt,
      source: lastSuccess.source,
    } satisfies TickerResponse)
  }

  const kv = await getKV()
  if (kv) {
    const fresh = await readKvFresh(kv)
    if (fresh) {
      lastSuccess = {
        chips: fresh.chips,
        fetchedAt: fresh.fetchedAt,
        source: fresh.source,
      }
      return NextResponse.json(fresh)
    }
  }

  // Backoff path — return cached if we have any.
  if (now < blockedUntil) {
    if (lastSuccess) {
      return NextResponse.json({
        chips: lastSuccess.chips,
        fetchedAt: lastSuccess.fetchedAt,
        source: lastSuccess.source,
        stale: true,
      } satisfies TickerResponse)
    }
    if (kv) {
      const stale = await readKvStale(kv)
      if (stale)
        return NextResponse.json({ ...stale, stale: true } satisfies TickerResponse)
    }
    return NextResponse.json(
      {
        error: "Ticker upstream rate-limited; no cache available yet.",
      },
      { status: 503 }
    )
  }

  const errors: string[] = []
  let saw429 = false
  for (const [name, fn] of [
    ["v7-multi", () => fetchV7Multi()],
    ["v8-direct", () => fetchV8Each(false)],
    ["v8-via-proxy", () => fetchV8Each(true)],
  ] as const) {
    try {
      const chips = await fn()
      if (chips.length === 0) {
        errors.push(`${name}: no chips returned`)
        continue
      }
      const payload: TickerResponse = {
        chips,
        fetchedAt: Date.now(),
        source: name,
      }
      lastSuccess = {
        chips,
        fetchedAt: payload.fetchedAt,
        source: name,
      }
      if (kv) {
        // Don't await on the hot path — writing to KV is best-effort
        // and shouldn't gate the response.
        void writeKv(kv, payload)
      }
      return NextResponse.json(payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${name}: ${msg}`)
      if (msg.includes("429")) saw429 = true
    }
  }

  // All sources failed. Set rate-limit backoff if any 429 surfaced and
  // serve the freshest stale we can find.
  if (saw429) blockedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS

  if (lastSuccess && Date.now() - lastSuccess.fetchedAt < STALE_TTL_MS) {
    return NextResponse.json({
      chips: lastSuccess.chips,
      fetchedAt: lastSuccess.fetchedAt,
      source: lastSuccess.source,
      stale: true,
    } satisfies TickerResponse)
  }
  if (kv) {
    const stale = await readKvStale(kv)
    if (stale)
      return NextResponse.json({ ...stale, stale: true } satisfies TickerResponse)
  }

  console.error("[ticker] All sources failed:", errors)
  return NextResponse.json(
    {
      error: errors.join(" | ") || "All ticker sources failed",
    },
    { status: saw429 ? 503 : 500 }
  )
}
