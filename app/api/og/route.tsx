import { ImageResponse } from "next/og"

// 1200x630 is the canonical Open Graph / Twitter Card size. We render a
// fresh snapshot of the live prices + ratio every time CF edge cache
// expires (s-maxage below). Naturally rate-limits to "every few hours per
// edge" without needing a cron — exactly what the user asked for.
//
// Note: no `runtime = "edge"` export — on OpenNext for Cloudflare every
// route already runs on workerd. Declaring the edge runtime would force
// this route into a separate function bundle.

interface Summary {
  cyphPrice: number | null
  cyphChange24h: number | null
  zecPrice: number | null
  zecChange24h: number | null
  ratio: number | null
  ratioVsAvg7d: number | null
  marketState: string | null
}

async function fetchSummary(origin: string): Promise<Summary> {
  const s: Summary = {
    cyphPrice: null,
    cyphChange24h: null,
    zecPrice: null,
    zecChange24h: null,
    ratio: null,
    ratioVsAvg7d: null,
    marketState: null,
  }
  // Hit our own cached endpoints — they handle Yahoo rate limiting and
  // fallbacks. settled() so a partial outage still produces an image.
  const [pricesRes, quoteRes] = await Promise.allSettled([
    fetch(`${origin}/api/prices?days=7`, { cache: "no-store" }),
    fetch(`${origin}/api/quote`, { cache: "no-store" }),
  ])

  if (pricesRes.status === "fulfilled" && pricesRes.value.ok) {
    const d = await pricesRes.value.json()
    s.zecPrice = d?.current?.zec?.price ?? null
    s.zecChange24h = d?.current?.zec?.change24h ?? null
    s.cyphPrice = d?.current?.cyph?.price ?? null
    s.cyphChange24h = d?.current?.cyph?.change24h ?? null
    if (Array.isArray(d?.history) && d.history.length > 0) {
      s.ratio = d.history[d.history.length - 1].ratio ?? null
    }
    s.ratioVsAvg7d = d?.stats?.ratio?.vsAvg7d ?? null
  }

  // Quote endpoint carries the live extended-hours / overnight tick. Prefer
  // that for the headline so the OG matches what the dashboard shows.
  if (quoteRes.status === "fulfilled" && quoteRes.value.ok) {
    const d = await quoteRes.value.json()
    s.marketState = d?.marketState ?? null
    const live =
      d?.overnightMarketPrice ??
      d?.postMarketPrice ??
      d?.preMarketPrice ??
      d?.regularMarketPrice ??
      null
    if (live != null) s.cyphPrice = live
  }

  return s
}

function fmtPrice(p: number | null) {
  if (p == null) return "—"
  return p < 1
    ? `$${p.toFixed(4)}`
    : `$${p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
}

function fmtChange(pct: number | null) {
  if (pct == null) return "—"
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`
}

function fmtRatio(r: number | null) {
  if (r == null) return "—"
  return r < 0.001 ? r.toExponential(3) : r.toPrecision(4)
}

const CYPH = "#34d399"
const ZEC = "#fb923c"
const SKY = "#38bdf8"
const GREEN = "#34d399"
const RED = "#f87171"
const FG = "#f5f5f5"
const MUTED = "#9ca3af"
const BG = "#0b0f14"
const CARD = "#10161c"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const s = await fetchSummary(origin)

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
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "40px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            {/* Mini Z logo: two coloured horizontal bars in a rounded box,
                matches the favicon's two-tone signature. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: "72px",
                height: "72px",
                justifyContent: "space-between",
                padding: "14px 12px",
                backgroundColor: BG,
                borderRadius: "14px",
                border: "2px solid #1f2937",
              }}
            >
              <div
                style={{
                  display: "flex",
                  height: "10px",
                  backgroundColor: CYPH,
                  borderRadius: "2px",
                }}
              />
              <div
                style={{
                  display: "flex",
                  height: "10px",
                  backgroundColor: ZEC,
                  borderRadius: "2px",
                }}
              />
            </div>
            <div style={{ display: "flex", fontSize: "52px", fontWeight: 800 }}>
              <span style={{ color: CYPH }}>$CYPH</span>
              <span style={{ color: "#475569", margin: "0 16px" }}>/</span>
              <span style={{ color: ZEC }}>$ZEC</span>
            </div>
          </div>
          {s.marketState && (
            <div
              style={{
                display: "flex",
                fontSize: "20px",
                color: MUTED,
                padding: "8px 16px",
                border: "1px solid #1f2937",
                borderRadius: "8px",
              }}
            >
              {s.marketState}
            </div>
          )}
        </div>

        {/* Three stat blocks */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: "20px",
            flex: 1,
            alignItems: "stretch",
          }}
        >
          <StatBlock
            ticker="$CYPH"
            name="Cypherpunk Holdings"
            color={CYPH}
            price={fmtPrice(s.cyphPrice)}
            changeText={`${fmtChange(s.cyphChange24h)} 24h`}
            changeColor={(s.cyphChange24h ?? 0) >= 0 ? GREEN : RED}
          />
          <StatBlock
            ticker="$ZEC"
            name="Zcash"
            color={ZEC}
            price={fmtPrice(s.zecPrice)}
            changeText={`${fmtChange(s.zecChange24h)} 24h`}
            changeColor={(s.zecChange24h ?? 0) >= 0 ? GREEN : RED}
          />
          <StatBlock
            ticker="CYPH/ZEC"
            name="Ratio"
            color={SKY}
            price={fmtRatio(s.ratio)}
            changeText={`${fmtChange(s.ratioVsAvg7d)} vs 7d avg`}
            changeColor={(s.ratioVsAvg7d ?? 0) >= 0 ? GREEN : RED}
          />
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "32px",
            fontSize: "20px",
            color: MUTED,
          }}
        >
          <div style={{ display: "flex" }}>cyphzec.jiggytom.com</div>
          <div style={{ display: "flex" }}>Updated {stamp}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // CF edge caches this for 3 hours, then serves stale-while-revalidate
        // for up to 24h while a fresh render runs in the background. Result:
        // the OG snapshot refreshes "every few hours per edge" naturally,
        // without us running a cron trigger or persisting to KV.
        "Cache-Control":
          "public, s-maxage=10800, stale-while-revalidate=86400",
      },
    }
  )
}

function StatBlock({
  ticker,
  name,
  color,
  price,
  changeText,
  changeColor,
}: {
  ticker: string
  name: string
  color: string
  price: string
  changeText: string
  changeColor: string
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        backgroundColor: CARD,
        borderRadius: "16px",
        border: `2px solid ${color}33`,
        padding: "32px 28px",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div
          style={{
            display: "flex",
            width: "12px",
            height: "12px",
            borderRadius: "100%",
            backgroundColor: color,
          }}
        />
        <div style={{ display: "flex", fontSize: "22px", color: MUTED }}>
          {ticker} · {name}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", fontSize: "60px", fontWeight: 800 }}>
          {price}
        </div>
        <div style={{ display: "flex", fontSize: "24px", color: changeColor }}>
          {changeText}
        </div>
      </div>
    </div>
  )
}
