import { ImageResponse } from "next/og"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  isFiniteNumber,
  missingOgDataResponse,
  ogHeaders,
  wantsCompleteOgImage,
} from "@/lib/og-complete"

// 1200x630 social card for /order-flow. Pulls live numbers from our own
// /api/zec-depth so the image shows the actual book: consensus mid, the
// aggregate spread, ±1% depth, which side is heavy, and how the depth is
// split across exchanges.
//
// This route exists because /order-flow briefly shipped pointing at
// /api/og/stats, which renders rank and supply figures and prints
// "cyphzec.com/stats" in its own footer — so every share of the new page
// was labelled as a different page.
//
// Cache strategy matches the other cards: 3h CF edge, 24h SWR window.

interface DepthMarketLite {
  pair: string
  ok: boolean
  depthUsd: number
}

interface DepthExchangeLite {
  name: string
  ok: boolean
  depthUsd: number
  share: number
  markets: DepthMarketLite[]
}

interface DepthLite {
  fetchedAt?: number
  /** Set by the depth route when it serves a carried-forward snapshot rather
   *  than a fresh build. Absent on the KV mirror, which is only ever written
   *  from a successful build. */
  stale?: boolean
  mid: number | null
  spreadBps: number | null
  imbalance1pct: number | null
  totals: { bidUsd: number; askUsd: number }
  exchanges: DepthExchangeLite[]
  exchangesOk: number
  exchangesTotal: number
  marketsOk: number
  marketsTotal: number
}

interface FlowSummary {
  /** When the snapshot was built, not when this image was rendered. */
  fetchedAt: number | null
  /** The upstream told us this is a carried-forward book, so say so on the
   *  card rather than passing it off as a live read. */
  stale: boolean
  mid: number | null
  spreadBps: number | null
  depth1pct: number | null
  imbalance: number | null
  bidUsd: number | null
  askUsd: number | null
  exchangesOk: number | null
  exchangesTotal: number | null
  marketsOk: number | null
  top: { name: string; share: number; pairs: number }[]
}

/** The depth route's KV mirror. Reading it directly is the cheap path for a
 *  social card, and the reliable one.
 *
 *  Fetching `${origin}/api/zec-depth` instead means a Worker subrequest back
 *  into the same Worker, and when that misses every cache the depth route has
 *  to complete a 22-endpoint fan-out inside the nested request's budget. It
 *  frequently can't: measured against production, that path returned no data
 *  on three of eight samples, each failing at around 8 s, which is the depth
 *  route's own chain budget rather than any timeout here. Raising the timeout
 *  did nothing, because the fetch was not timing out — the build underneath
 *  it was giving up.
 *
 *  The mirror is written at least every 30 s and this image is cached for
 *  three hours, so its age is irrelevant here, and reading it costs one KV
 *  get with no fan-out at all. */
const KV_KEY = "zec.depth.stale.v3"

/** How old a mirrored snapshot may be and still be worth rendering. The
 *  writer keeps entries for 15 minutes and the depth route serves its own
 *  stale copies up to 10, but neither bound belongs on a card that stamps a
 *  time on the image: a quarter-hour-old book of resting liquidity labelled
 *  with the current minute is a wrong picture, not a slightly late one.
 *
 *  Five minutes sits far above the 30 s write spacing, so any site with
 *  traffic hits this every time, while an idle deployment falls through to
 *  the endpoint and gets a real build or an honest blank. */
const MIRROR_MAX_AGE_MS = 5 * 60_000

async function readMirror(): Promise<DepthLite | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    const kv = (
      ctx?.env as { SUPPLY_CACHE?: { get: (k: string) => Promise<string | null> } } | undefined
    )?.SUPPLY_CACHE
    if (!kv) return null
    const raw = await kv.get(KV_KEY)
    return raw ? (JSON.parse(raw) as DepthLite) : null
  } catch {
    return null
  }
}

function summarize(d: DepthLite): FlowSummary {
  const s: FlowSummary = {
    fetchedAt: null,
    stale: false,
    mid: null,
    spreadBps: null,
    depth1pct: null,
    imbalance: null,
    bidUsd: null,
    askUsd: null,
    exchangesOk: null,
    exchangesTotal: null,
    marketsOk: null,
    top: [],
  }
  s.fetchedAt = isFiniteNumber(d.fetchedAt) ? d.fetchedAt : null
  s.stale = d.stale === true
  s.mid = isFiniteNumber(d.mid) ? d.mid : null
  s.spreadBps = isFiniteNumber(d.spreadBps) ? d.spreadBps : null
  s.imbalance = isFiniteNumber(d.imbalance1pct) ? d.imbalance1pct : null
  s.exchangesOk = isFiniteNumber(d.exchangesOk) ? d.exchangesOk : null
  s.exchangesTotal = isFiniteNumber(d.exchangesTotal) ? d.exchangesTotal : null
  s.marketsOk = isFiniteNumber(d.marketsOk) ? d.marketsOk : null
  const live = Array.isArray(d.exchanges) ? d.exchanges.filter((e) => e.ok) : []
  s.depth1pct = live.reduce((t, e) => t + (e.depthUsd || 0), 0) || null
  s.bidUsd = isFiniteNumber(d.totals?.bidUsd) ? d.totals.bidUsd : null
  s.askUsd = isFiniteNumber(d.totals?.askUsd) ? d.totals.askUsd : null
  s.top = [...live]
    .sort((a, b) => (b.share || 0) - (a.share || 0))
    .slice(0, 4)
    .map((e) => ({
      name: e.name,
      share: e.share || 0,
      pairs: Array.isArray(e.markets)
        ? e.markets.filter((m) => m.ok).length
        : 1,
    }))
  return s
}

async function fetchSummary(origin: string): Promise<FlowSummary> {
  const s: FlowSummary = {
    fetchedAt: null,
    stale: false,
    mid: null,
    spreadBps: null,
    depth1pct: null,
    imbalance: null,
    bidUsd: null,
    askUsd: null,
    exchangesOk: null,
    exchangesTotal: null,
    marketsOk: null,
    top: [],
  }
  const fresh = (c: FlowSummary): boolean =>
    c.mid != null &&
    c.top.length > 0 &&
    c.fetchedAt != null &&
    Date.now() - c.fetchedAt < MIRROR_MAX_AGE_MS

  const mirror = await readMirror()
  const fromKv = mirror ? summarize(mirror) : null
  if (fromKv && fresh(fromKv)) return fromKv

  // Mirror missing, or older than we are willing to stamp a time on. Try the
  // endpoint — deliberately NOT `cache: "no-store"`, unlike the other cards:
  // their upstreams are one cheap call, while this one re-enters the depth
  // route, and on a cache miss that means a 22-endpoint fan-out inside a
  // nested request's budget, which it frequently cannot finish.
  //
  // Short timeout on purpose. Social scrapers give up in single-digit
  // seconds, so waiting longer buys a render nobody receives, and the depth
  // route's own caches answer in well under a second whenever they hold
  // anything at all.
  try {
    const res = await fetch(`${origin}/api/zec-depth`, {
      signal: AbortSignal.timeout(6_000),
    })
    if (res.ok) {
      const live = summarize((await res.json()) as DepthLite)
      if (fresh(live)) return live
      // Neither is fresh, but both are real: take the newer rather than
      // rendering nothing.
      if (fromKv == null) return live
      return (live.fetchedAt ?? 0) >= (fromKv.fetchedAt ?? 0) ? live : fromKv
    }
  } catch {
    /* fall through to whatever the mirror gave us */
  }
  // Endpoint unreachable. An aged mirror beats a card of em dashes, provided
  // the footer stamps its real age and the header says CACHED — both of which
  // it now does.
  return fromKv ?? s
}

function missingSummaryFields(s: FlowSummary): string[] {
  const missing: string[] = []
  if (s.mid == null) missing.push("mid")
  if (s.depth1pct == null) missing.push("depth1pct")
  if (s.exchangesOk == null) missing.push("exchangesOk")
  if (s.top.length === 0) missing.push("exchanges")
  // Without this the footer stamps the render time and claims a freshness
  // the book may not have.
  if (s.fetchedAt == null) missing.push("fetchedAt")
  // Without these the bid/ask bar draws a fabricated 50/50 split.
  if (s.bidUsd == null || s.askUsd == null) missing.push("totals")
  return missing
}

const CYPH = "#34d399"
const ZEC = "#fde047"
const RED = "#f87171"
const FG = "#dcfce7"
const MUTED = "#86efac"
const BG = "#000000"
const CARD = "rgba(0,0,0,0.72)"
const SCANLINE = "rgba(52,211,153,0.05)"

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const requireComplete = wantsCompleteOgImage(request)
  const s = await fetchSummary(origin)
  if (requireComplete) {
    const missing = missingSummaryFields(s)
    if (missing.length > 0) {
      return missingOgDataResponse("/api/og/order-flow", missing)
    }
  }

  // A card that failed to get data still renders, with em dashes — but it
  // must not then sit in the edge cache for three hours. Short TTL on an
  // incomplete render so the next scrape retries.
  const complete = missingSummaryFields(s).length === 0
  const cacheControl = complete
    ? "public, s-maxage=10800, stale-while-revalidate=86400"
    : "public, s-maxage=60"

  // Stamped from the snapshot, not from `Date.now()`. The render time would
  // claim a freshness the book may not have.
  const now = new Date(s.fetchedAt ?? Date.now())
  // Two ways a card can be showing an old book: the depth route told us it
  // carried one forward, or we fell back to a mirror past the age we are
  // willing to call current. The mirror is only ever written from a good
  // build, so it never sets `stale` itself — the age check is what covers
  // that path, and both want the same badge.
  const showCached =
    s.stale ||
    (s.fetchedAt != null && Date.now() - s.fetchedAt >= MIRROR_MAX_AGE_MS)
  const stamp =
    now.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"

  const bid = s.bidUsd ?? 0
  const ask = s.askUsd ?? 0
  const bidPct = bid + ask > 0 ? (bid / (bid + ask)) * 100 : 50
  // Mirrors imbalanceLabel() in components/order-depth.tsx: magnitude plus a
  // direction word, with anything under 3% called balanced rather than given
  // a side. Printing the signed value next to the word said it twice, and the
  // minus sign contradicted the word.
  const imbPct = s.imbalance != null ? Math.abs(s.imbalance) * 100 : null
  const imbBalanced = imbPct != null && imbPct < 3
  const askHeavy = (s.imbalance ?? 0) < 0
  const imbColor = imbBalanced ? FG : askHeavy ? RED : CYPH
  const imbText =
    imbPct == null
      ? "imbalance —"
      : imbBalanced
        ? `${imbPct.toFixed(1)}% balanced`
        : `${imbPct.toFixed(1)}% ${askHeavy ? "ask-heavy" : "bid-heavy"}`

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: BG,
          color: FG,
          padding: "48px 64px",
          fontFamily: "monospace",
          backgroundImage: `repeating-linear-gradient(0deg, ${SCANLINE} 0px, ${SCANLINE} 1px, transparent 1px, transparent 4px)`,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "24px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: "44px", fontWeight: 800 }}>
              <span style={{ color: ZEC }}>$ZEC</span>
              <span style={{ color: MUTED, marginLeft: "16px" }}>
                Order Flow
              </span>
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "20px",
                color: MUTED,
                marginTop: "4px",
              }}
            >
              Aggregated depth · taker tape · price action
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "20px",
              color: showCached ? ZEC : CYPH,
              padding: "10px 18px",
              border: `2px solid ${showCached ? ZEC : CYPH}55`,
              backgroundColor: `${showCached ? ZEC : CYPH}11`,
              fontWeight: 700,
            }}
          >
            {/* The coverage count is the most useful thing in the header, so
                CACHED prefixes it rather than replacing it. */}
            {(showCached ? "CACHED · " : "") +
              (s.exchangesOk != null && s.exchangesTotal != null
                ? `${s.exchangesOk}/${s.exchangesTotal} EXCHANGES · ${s.marketsOk ?? "—"} BOOKS`
                : showCached
                  ? "BOOK"
                  : "LIVE BOOK")}
          </div>
        </div>

        {/* Hero: mid + the three headline figures */}
        <div
          style={{
            display: "flex",
            backgroundColor: CARD,
            border: `2px solid ${ZEC}33`,
            padding: "24px 36px",
            marginBottom: "20px",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div style={{ display: "flex", fontSize: "20px", color: MUTED }}>
              Consensus mid
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "72px",
                fontWeight: 800,
                color: ZEC,
                lineHeight: 1,
              }}
            >
              {s.mid != null ? `$${s.mid.toFixed(2)}` : "—"}
            </div>
            <div style={{ display: "flex", fontSize: "22px", color: FG }}>
              {s.spreadBps != null
                ? `${s.spreadBps.toFixed(2)} bp aggregate spread`
                : "spread —"}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "8px",
            }}
          >
            <div style={{ display: "flex", fontSize: "20px", color: MUTED }}>
              Depth ±1%
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "62px",
                fontWeight: 800,
                color: CYPH,
                lineHeight: 1,
              }}
            >
              {fmtUsd(s.depth1pct)}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "22px",
                color: imbColor,
              }}
            >
              {imbText}
            </div>
          </div>
        </div>

        {/* Bid / ask split across ±2% */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "20px",
              color: MUTED,
            }}
          >
            <div style={{ display: "flex" }}>BIDS {fmtUsd(s.bidUsd)}</div>
            <div style={{ display: "flex" }}>CUMULATIVE ±2%</div>
            <div style={{ display: "flex" }}>{fmtUsd(s.askUsd)} ASKS</div>
          </div>
          <div
            style={{
              display: "flex",
              height: "22px",
              border: `2px solid ${MUTED}33`,
            }}
          >
            <div
              style={{
                display: "flex",
                width: `${bidPct}%`,
                backgroundColor: CYPH,
                opacity: 0.8,
              }}
            />
            <div
              style={{
                display: "flex",
                width: `${100 - bidPct}%`,
                backgroundColor: RED,
                opacity: 0.8,
              }}
            />
          </div>
        </div>

        {/* Where the depth sits */}
        <div
          style={{
            display: "flex",
            gap: "14px",
            marginTop: "20px",
            flex: 1,
          }}
        >
          {s.top.map((e) => (
            <div
              key={e.name}
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                backgroundColor: CARD,
                border: `2px solid ${CYPH}22`,
                padding: "14px 18px",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: "17px",
                  color: MUTED,
                }}
              >
                {e.name} · {e.pairs === 1 ? "1 book" : `${e.pairs} books`}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "34px",
                  fontWeight: 800,
                  color: CYPH,
                  lineHeight: 1,
                }}
              >
                {(e.share * 100).toFixed(1)}%
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "20px",
            fontSize: "20px",
            color: MUTED,
          }}
        >
          <div style={{ display: "flex" }}>cyphzec.com/order-flow</div>
          <div style={{ display: "flex" }}>Updated {stamp}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        ...ogHeaders(requireComplete, cacheControl),
      },
    }
  )
}
