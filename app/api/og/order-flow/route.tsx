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
  const mirror = await readMirror()
  if (mirror) {
    const fromKv = summarize(mirror)
    if (fromKv.mid != null && fromKv.top.length > 0) return fromKv
  }
  // No mirror yet — a brand new deploy, or KV unbound in local preview. Fall
  // back to the endpoint, without `no-store` so a cached answer can serve it.
  try {
    const res = await fetch(`${origin}/api/zec-depth`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return s
    return summarize((await res.json()) as DepthLite)
  } catch {
    /* leave the summary empty — the card degrades to em dashes */
  }
  return s
}

function missingSummaryFields(s: FlowSummary): string[] {
  const missing: string[] = []
  if (s.mid == null) missing.push("mid")
  if (s.depth1pct == null) missing.push("depth1pct")
  if (s.exchangesOk == null) missing.push("exchangesOk")
  if (s.top.length === 0) missing.push("exchanges")
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

  const now = new Date()
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
  const askHeavy = (s.imbalance ?? 0) < 0

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
              color: CYPH,
              padding: "10px 18px",
              border: `2px solid ${CYPH}55`,
              backgroundColor: `${CYPH}11`,
              fontWeight: 700,
            }}
          >
            {s.exchangesOk != null && s.exchangesTotal != null
              ? `${s.exchangesOk}/${s.exchangesTotal} EXCHANGES · ${s.marketsOk ?? "—"} BOOKS`
              : "LIVE BOOK"}
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
                color: askHeavy ? RED : CYPH,
              }}
            >
              {s.imbalance != null
                ? `${(s.imbalance * 100).toFixed(1)}% ${askHeavy ? "ask-heavy" : "bid-heavy"}`
                : "imbalance —"}
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
