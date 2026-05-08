import { ImageResponse } from "next/og"

// 1200x630 social card for the /stats page. Pulls live numbers from our
// own /api/markets + /api/zec-stats so the image always reflects current
// state — ZEC's rank, the next coin to flip, current shielded %, and the
// 7d/30d mcap performance.
//
// Cache strategy: CF edge holds the rendered PNG for 3h (matches the
// home OG), with a 24h SWR window. Twitter / OG scrapers see a fresh
// image after each re-scrape since the /stats page metadata pins a
// daily-granularity ?d=YYYYMMDD param to the URL — that bumps the URL
// once per UTC day, prompting Twitter to re-fetch even when nothing
// else about the page changed.

interface MarketCoinLite {
  rank: number
  symbol: string
  marketCap: number | null
  circulatingSupply: number | null
}

interface ZecStatsLite {
  marketCap: number | null
  shieldedPct: number | null
  mcapChange7d: number | null
  mcapChange30d: number | null
  rank: number | null
  price: number | null
  change24h: number | null
}

interface StatsSummary {
  zecRank: number | null
  zecPrice: number | null
  zecMcap: number | null
  shieldedPct: number | null
  mcap7d: number | null
  mcap30d: number | null
  /** Symbol of coin one rank above ZEC, plus price/% needed to flip. */
  nextSymbol: string | null
  flipPriceDelta: number | null
  flipPctDelta: number | null
}

async function fetchSummary(origin: string): Promise<StatsSummary> {
  const s: StatsSummary = {
    zecRank: null,
    zecPrice: null,
    zecMcap: null,
    shieldedPct: null,
    mcap7d: null,
    mcap30d: null,
    nextSymbol: null,
    flipPriceDelta: null,
    flipPctDelta: null,
  }
  // settled() — partial outage shouldn't break the image entirely.
  const [marketsRes, zecRes] = await Promise.allSettled([
    fetch(`${origin}/api/markets`, { cache: "no-store" }),
    fetch(`${origin}/api/zec-stats`, { cache: "no-store" }),
  ])

  if (zecRes.status === "fulfilled" && zecRes.value.ok) {
    const d = (await zecRes.value.json()) as ZecStatsLite
    s.zecRank = d.rank ?? null
    s.zecPrice = d.price ?? null
    s.zecMcap = d.marketCap ?? null
    s.shieldedPct = d.shieldedPct ?? null
    s.mcap7d = d.mcapChange7d ?? null
    s.mcap30d = d.mcapChange30d ?? null
  }

  if (marketsRes.status === "fulfilled" && marketsRes.value.ok) {
    const d = (await marketsRes.value.json()) as { coins: MarketCoinLite[] }
    const zec = d.coins?.find((c) => c.symbol === "ZEC")
    if (zec?.marketCap != null && zec.circulatingSupply && zec.circulatingSupply > 0) {
      const next = d.coins?.find((c) => c.rank === zec.rank - 1)
      if (next?.marketCap != null) {
        const zecPrice = zec.marketCap / zec.circulatingSupply
        const deltaMcap = next.marketCap - zec.marketCap
        const deltaPrice = deltaMcap / zec.circulatingSupply
        s.nextSymbol = next.symbol
        s.flipPriceDelta = deltaPrice
        s.flipPctDelta = zecPrice > 0 ? (deltaPrice / zecPrice) * 100 : null
      }
    }
  }

  return s
}

function fmtMcap(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtPct(p: number | null) {
  if (p == null) return "—"
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`
}

const CYPH = "#34d399"
const ZEC = "#fb923c"
const SHIELD = "#34d399"
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
            marginBottom: "32px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: "64px",
                height: "64px",
                justifyContent: "space-between",
                padding: "12px 10px",
                backgroundColor: BG,
                borderRadius: "12px",
                border: "2px solid #1f2937",
              }}
            >
              <div
                style={{
                  display: "flex",
                  height: "8px",
                  backgroundColor: CYPH,
                  borderRadius: "2px",
                }}
              />
              <div
                style={{
                  display: "flex",
                  height: "8px",
                  backgroundColor: ZEC,
                  borderRadius: "2px",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: "44px", fontWeight: 800 }}>
                <span style={{ color: ZEC }}>$ZEC</span>
                <span style={{ color: MUTED, marginLeft: "16px" }}>
                  Stats &amp; Rankings
                </span>
              </div>
              <div style={{ display: "flex", fontSize: "20px", color: MUTED, marginTop: "4px" }}>
                Top-50 leaderboard · supply · shielded breakdown
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "20px",
              color: ZEC,
              padding: "10px 18px",
              border: `2px solid ${ZEC}55`,
              borderRadius: "10px",
              backgroundColor: `${ZEC}11`,
              fontWeight: 700,
            }}
          >
            {s.zecRank != null ? `RANK #${s.zecRank}` : "ZEC"}
          </div>
        </div>

        {/* Hero rank block + flip target */}
        <div
          style={{
            display: "flex",
            backgroundColor: CARD,
            border: `2px solid ${ZEC}33`,
            borderRadius: "20px",
            padding: "32px 36px",
            marginBottom: "20px",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", fontSize: "20px", color: MUTED }}>
              Zcash market-cap rank
            </div>
            <div style={{ display: "flex", fontSize: "84px", fontWeight: 800, color: ZEC, lineHeight: 1 }}>
              #{s.zecRank ?? "—"}
            </div>
            <div style={{ display: "flex", fontSize: "22px", color: FG }}>
              {fmtMcap(s.zecMcap)} mcap
            </div>
          </div>
          {s.nextSymbol && s.flipPriceDelta != null ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
              <div style={{ display: "flex", fontSize: "20px", color: MUTED }}>
                Next to flip
              </div>
              <div style={{ display: "flex", fontSize: "56px", fontWeight: 800, color: FG, lineHeight: 1 }}>
                {s.nextSymbol}
              </div>
              <div style={{ display: "flex", fontSize: "22px", color: GREEN }}>
                +${Math.abs(s.flipPriceDelta).toFixed(s.flipPriceDelta > 100 ? 0 : 2)}
                {s.flipPctDelta != null && (
                  <span style={{ color: MUTED, marginLeft: "8px" }}>
                    ({fmtPct(s.flipPctDelta)})
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: "22px", color: MUTED }}>
              {s.zecRank === 1 ? "ZEC is #1" : "—"}
            </div>
          )}
        </div>

        {/* Three side stat blocks: shielded · 7d mcap · 30d mcap */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: "16px",
            flex: 1,
            alignItems: "stretch",
          }}
        >
          <SideBlock
            label="Shielded supply"
            value={s.shieldedPct != null ? `${s.shieldedPct.toFixed(1)}%` : "—"}
            sub="of circulating ZEC"
            accent={SHIELD}
          />
          <SideBlock
            label="Mcap · 7D"
            value={fmtPct(s.mcap7d)}
            sub="market cap"
            accent={(s.mcap7d ?? 0) >= 0 ? GREEN : RED}
          />
          <SideBlock
            label="Mcap · 30D"
            value={fmtPct(s.mcap30d)}
            sub="market cap"
            accent={(s.mcap30d ?? 0) >= 0 ? GREEN : RED}
          />
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
          <div style={{ display: "flex" }}>cyphzec.com/stats</div>
          <div style={{ display: "flex" }}>Updated {stamp}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // Same caching contract as /api/og: 3h CF edge, 24h SWR.
        "Cache-Control":
          "public, s-maxage=10800, stale-while-revalidate=86400",
      },
    }
  )
}

function SideBlock({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub: string
  accent: string
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        backgroundColor: CARD,
        borderRadius: "16px",
        border: `2px solid ${accent}33`,
        padding: "24px 24px",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", fontSize: "18px", color: MUTED }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", fontSize: "52px", fontWeight: 800, color: accent }}>
          {value}
        </div>
        <div style={{ display: "flex", fontSize: "18px", color: MUTED }}>
          {sub}
        </div>
      </div>
    </div>
  )
}
