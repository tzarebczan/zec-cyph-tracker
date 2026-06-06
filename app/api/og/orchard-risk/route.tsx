import { ImageResponse } from "next/og"
import type {
  OrchardRiskHistoryPoint,
  OrchardRiskResponse,
} from "@/components/api-types"

type RiskSnapshot = Pick<
  OrchardRiskResponse,
  | "question"
  | "url"
  | "yesPrice"
  | "noPrice"
  | "yesBid"
  | "yesAsk"
  | "spread"
  | "volume"
  | "volume24h"
  | "liquidity"
  | "endDate"
  | "updatedAt"
  | "fetchedAt"
  | "history"
>

const BG = "#000000"
const TEXT = "#dcfce7"
const TEXT_DIM = "#86efac"
const CYPH = "#34d399"
const ZEC = "#fde047"
const RATIO = "#67e8f9"
const RED = "#f87171"
const CARD = "rgba(0,0,0,0.72)"
const DIVIDER = "rgba(220,252,231,0.18)"
const SCANLINE = "rgba(52,211,153,0.06)"

function fallbackSnapshot(): RiskSnapshot {
  return {
    question: "Zcash's Orchard pool confirmed exploited?",
    url: "https://polymarket.com/event/zcashs-orchard-pool-confirmed-exploited-20260605210804589",
    yesPrice: null,
    noPrice: null,
    yesBid: null,
    yesAsk: null,
    spread: null,
    volume: null,
    volume24h: null,
    liquidity: null,
    endDate: null,
    updatedAt: null,
    fetchedAt: Date.now(),
    history: [],
  }
}

async function fetchSnapshot(origin: string): Promise<RiskSnapshot> {
  try {
    const res = await fetch(`${origin}/api/orchard-risk`, {
      cache: "no-store",
    })
    if (!res.ok) return fallbackSnapshot()
    const data = (await res.json()) as OrchardRiskResponse
    return {
      question: data.question,
      url: data.url,
      yesPrice: data.yesPrice,
      noPrice: data.noPrice,
      yesBid: data.yesBid,
      yesAsk: data.yesAsk,
      spread: data.spread,
      volume: data.volume,
      volume24h: data.volume24h,
      liquidity: data.liquidity,
      endDate: data.endDate,
      updatedAt: data.updatedAt,
      fetchedAt: data.fetchedAt,
      history: data.history ?? [],
    }
  } catch {
    return fallbackSnapshot()
  }
}

function fmtOdds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${Math.round(value * 100)}%`
}

function fmtCents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${Math.round(value * 100)}c`
}

function fmtCompactUSD(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--"
  const abs = Math.abs(n)
  if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T"
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "--"
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
}

function fmtStamp(ms: number): string {
  return (
    new Date(ms).toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"
  )
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const s = await fetchSnapshot(origin)
  const yesPct =
    s.yesPrice == null || !Number.isFinite(s.yesPrice)
      ? 0
      : Math.max(0, Math.min(100, s.yesPrice * 100))
  const noPct = Math.max(0, 100 - yesPct)
  const history = s.history.slice(-42)
  const latest = history.at(-1)

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: BG,
          color: TEXT,
          padding: "40px 52px",
          fontFamily: "monospace",
          backgroundImage: `repeating-linear-gradient(0deg, ${SCANLINE} 0px, ${SCANLINE} 1px, transparent 1px, transparent 4px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "26px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
            <div
              style={{
                display: "flex",
                width: "66px",
                height: "66px",
                border: `2px solid ${RED}66`,
                backgroundColor: `${RED}10`,
                alignItems: "center",
                justifyContent: "center",
                color: RED,
                fontSize: "34px",
                fontWeight: 800,
              }}
            >
              ?
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  display: "flex",
                  fontSize: "18px",
                  color: TEXT_DIM,
                  letterSpacing: "0.22em",
                }}
              >
                CYPH / ZEC - POLYMARKET SIGNAL
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "46px",
                  fontWeight: 800,
                  color: RED,
                  lineHeight: 1.05,
                  marginTop: "4px",
                }}
              >
                ORCHARD RISK MARKET
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "5px",
              fontSize: "18px",
              color: TEXT_DIM,
            }}
          >
            <div style={{ display: "flex", color: ZEC, fontWeight: 800 }}>
              $ZEC
            </div>
            <div style={{ display: "flex" }}>cyphzec.com/orchard-risk</div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            gap: "22px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "43%",
              backgroundColor: CARD,
              border: `2px solid ${RED}44`,
              padding: "28px 30px",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  display: "flex",
                  fontSize: "19px",
                  color: TEXT_DIM,
                  letterSpacing: "0.16em",
                }}
              >
                YES PROBABILITY
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "112px",
                  fontWeight: 900,
                  color: RED,
                  lineHeight: 0.96,
                  marginTop: "12px",
                }}
              >
                {fmtOdds(s.yesPrice)}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "24px",
                  color: TEXT,
                  marginTop: "12px",
                  lineHeight: 1.25,
                }}
              >
                {s.question}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div
                style={{
                  display: "flex",
                  height: "18px",
                  width: "100%",
                  backgroundColor: "rgba(220,252,231,0.10)",
                }}
              >
                <div style={{ display: "flex", width: `${yesPct}%`, backgroundColor: RED }} />
                <div style={{ display: "flex", width: `${noPct}%`, backgroundColor: CYPH }} />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "18px",
                  letterSpacing: "0.12em",
                }}
              >
                <span style={{ display: "flex", color: RED }}>
                  YES {fmtCents(s.yesPrice)}
                </span>
                <span style={{ display: "flex", color: CYPH }}>
                  NO {fmtCents(s.noPrice)}
                </span>
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: "16px",
            }}
          >
            <div style={{ display: "flex", gap: "14px" }}>
              <Stat label="BID" value={fmtCents(s.yesBid)} color={CYPH} />
              <Stat label="ASK" value={fmtCents(s.yesAsk)} color={RED} />
              <Stat label="SPREAD" value={fmtCents(s.spread)} color={TEXT_DIM} />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                backgroundColor: CARD,
                border: `2px solid ${RED}33`,
                padding: "20px 22px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: "14px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: "18px",
                    color: TEXT_DIM,
                    letterSpacing: "0.18em",
                  }}
                >
                  YES PRICE HISTORY
                </div>
                <div style={{ display: "flex", fontSize: "18px", color: RED }}>
                  latest {latest ? fmtOdds(latest.price) : "--"}
                </div>
              </div>
              <HistoryBars history={history} />
            </div>

            <div style={{ display: "flex", gap: "14px" }}>
              <Stat label="VOLUME" value={fmtCompactUSD(s.volume)} color={ZEC} />
              <Stat label="24H VOL" value={fmtCompactUSD(s.volume24h)} color={ZEC} />
              <Stat label="LIQUIDITY" value={fmtCompactUSD(s.liquidity)} color={RATIO} />
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "22px",
            paddingTop: "14px",
            borderTop: `1px solid ${DIVIDER}`,
            fontSize: "17px",
            color: TEXT_DIM,
            letterSpacing: "0.12em",
          }}
        >
          <div style={{ display: "flex" }}>
            Market signal, not protocol evidence - close {fmtDate(s.endDate)}
          </div>
          <div style={{ display: "flex" }}>
            UPDATED {fmtStamp(s.fetchedAt || Date.now())}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control":
          "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    }
  )
}

function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: "8px",
        backgroundColor: `${color}10`,
        border: `2px solid ${color}33`,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: "15px",
          color: TEXT_DIM,
          letterSpacing: "0.18em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: "28px",
          fontWeight: 800,
          color,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function HistoryBars({ history }: { history: OrchardRiskHistoryPoint[] }) {
  if (history.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          height: "104px",
          alignItems: "center",
          justifyContent: "center",
          color: TEXT_DIM,
          fontSize: "18px",
          border: `1px solid ${DIVIDER}`,
        }}
      >
        PRICE HISTORY WARMING
      </div>
    )
  }

  const prices = history.map((point) => point.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = Math.max(0.01, max - min)

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: "5px",
        height: "104px",
        borderBottom: `1px solid ${DIVIDER}`,
        borderTop: `1px solid ${DIVIDER}`,
        padding: "10px 0",
      }}
    >
      {history.map((point) => {
        const normalized = (point.price - min) / span
        const height = 14 + normalized * 78
        return (
          <div
            key={`${point.timestamp}-${point.price}`}
            style={{
              display: "flex",
              flex: 1,
              height: `${height}px`,
              backgroundColor: RED,
              opacity: 0.35 + normalized * 0.55,
              boxShadow: `0 0 10px ${RED}66`,
            }}
          />
        )
      })}
    </div>
  )
}
