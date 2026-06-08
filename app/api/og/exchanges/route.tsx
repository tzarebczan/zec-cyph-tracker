import { ImageResponse } from "next/og"
import {
  isFiniteNumber,
  missingOgDataResponse,
  ogHeaders,
  wantsCompleteOgImage,
} from "@/lib/og-complete"

interface ExchangeLite {
  exchange: string
  exchangeId: string
  volumeUsd24h: number
  share: number
  marketCount: number
  volumeChange24h: number | null
  volumeChangeWindowHours: number | null
}

interface PairLite {
  pair: string
  volumeUsd24h: number
  share: number
}

interface ExchangesLite {
  total24hVolumeUsd: number
  exchangeCount: number
  marketCount: number
  byExchange: ExchangeLite[]
  byPair: PairLite[]
  fetchedAt: number
  stale?: boolean
}

interface Snapshot {
  total24hVolumeUsd: number | null
  exchangeCount: number | null
  marketCount: number | null
  topExchanges: ExchangeLite[]
  topPairs: PairLite[]
  fetchedAt: number | null
  stale: boolean
}

async function fetchSnapshot(origin: string): Promise<Snapshot> {
  const fallback: Snapshot = {
    total24hVolumeUsd: null,
    exchangeCount: null,
    marketCount: null,
    topExchanges: [],
    topPairs: [],
    fetchedAt: null,
    stale: false,
  }

  try {
    const res = await fetch(`${origin}/api/zec-exchanges`, {
      cache: "no-store",
    })
    if (!res.ok) return fallback
    const data = (await res.json()) as ExchangesLite
    return {
      total24hVolumeUsd: data.total24hVolumeUsd ?? null,
      exchangeCount: data.exchangeCount ?? null,
      marketCount: data.marketCount ?? null,
      topExchanges: (data.byExchange ?? []).slice(0, 5),
      topPairs: (data.byPair ?? []).slice(0, 5),
      fetchedAt: data.fetchedAt ?? null,
      stale: Boolean(data.stale),
    }
  } catch {
    return fallback
  }
}

function missingSnapshotFields(s: Snapshot): string[] {
  const required: Array<[keyof Snapshot, unknown]> = [
    ["total24hVolumeUsd", s.total24hVolumeUsd],
    ["exchangeCount", s.exchangeCount],
    ["marketCount", s.marketCount],
    ["fetchedAt", s.fetchedAt],
  ]
  const missing = required
    .filter(([, value]) => !isFiniteNumber(value))
    .map(([name]) => name)
  if (s.topExchanges.length < 3) missing.push("topExchanges")
  if (s.topPairs.length < 3) missing.push("topPairs")
  return missing
}

function fmtCompactUSD(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-"
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtShare(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-"
  return `${(n * 100).toFixed(1)}%`
}

function fmtChange(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-"
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`
}

function fmtStamp(ts: number | null): string {
  const d = ts != null ? new Date(ts) : new Date()
  return (
    d.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"
  )
}

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

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const requireComplete = wantsCompleteOgImage(request)
  const s = await fetchSnapshot(origin)
  if (requireComplete) {
    const missing = missingSnapshotFields(s)
    if (missing.length > 0) {
      return missingOgDataResponse("/api/og/exchanges", missing)
    }
  }

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
          padding: "42px 54px",
          fontFamily: "monospace",
          backgroundImage: `repeating-linear-gradient(0deg, ${SCANLINE} 0px, ${SCANLINE} 1px, transparent 1px, transparent 4px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "24px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: "48px",
                lineHeight: 1,
                fontWeight: 800,
                color: ZEC,
              }}
            >
              ZEC EXCHANGE STATS
            </div>
            <div
              style={{
                display: "flex",
                marginTop: "10px",
                fontSize: "20px",
                color: TEXT_DIM,
              }}
            >
              Live venue share, 24h volume flow, and top trading pairs
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "7px",
              fontSize: "18px",
              color: TEXT_DIM,
            }}
          >
            <span style={{ display: "flex", color: ZEC, fontWeight: 800 }}>
              {fmtCompactUSD(s.total24hVolumeUsd)} 24H VOL
            </span>
            <span style={{ display: "flex" }}>
              {s.exchangeCount ?? "-"} venues / {s.marketCount ?? "-"} markets
            </span>
            <span style={{ display: "flex", opacity: 0.62 }}>
              Updated {fmtStamp(s.fetchedAt)}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: "20px", flex: 1 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1.35,
              backgroundColor: CARD,
              border: `2px solid ${ZEC}33`,
              padding: "24px",
            }}
          >
            <SectionTitle label="TOP VENUES" accent={ZEC} />
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {s.topExchanges.map((ex, i) => (
                <VenueRow key={ex.exchangeId} ex={ex} rank={i + 1} />
              ))}
              {s.topExchanges.length === 0 && (
                <div style={{ display: "flex", color: TEXT_DIM, fontSize: "24px" }}>
                  Exchange data unavailable
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: "18px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                backgroundColor: CARD,
                border: `2px solid ${RATIO}33`,
                padding: "22px",
                flex: 1,
              }}
            >
              <SectionTitle label="TOP PAIRS" accent={RATIO} />
              <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
                {s.topPairs.map((pair) => (
                  <PairRow key={pair.pair} pair={pair} />
                ))}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                backgroundColor: CARD,
                border: `2px solid ${CYPH}33`,
                padding: "20px 22px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: "17px",
                  color: TEXT_DIM,
                  letterSpacing: "0.16em",
                }}
              >
                HISTORY WINDOW
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "28px",
                  color: CYPH,
                  fontWeight: 800,
                  marginTop: "8px",
                }}
              >
                24H RING LIVE
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "17px",
                  color: TEXT_DIM,
                  marginTop: "7px",
                  opacity: 0.72,
                }}
              >
                1M / 3M venue history requires longer collection.
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "18px",
            fontSize: "19px",
            color: TEXT_DIM,
          }}
        >
          <span style={{ display: "flex" }}>cyphzec.com/exchanges</span>
          <span style={{ display: "flex" }}>
            CoinGecko tickers / rolling local snapshots{s.stale ? " / cached" : ""}
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        ...ogHeaders(
          requireComplete,
          "public, s-maxage=3600, stale-while-revalidate=86400"
        ),
      },
    }
  )
}

function SectionTitle({ label, accent }: { label: string; accent: string }) {
  return (
    <div
      style={{
        display: "flex",
        color: accent,
        fontSize: "18px",
        letterSpacing: "0.22em",
        fontWeight: 800,
        marginBottom: "16px",
      }}
    >
      {label}
    </div>
  )
}

function VenueRow({ ex, rank }: { ex: ExchangeLite; rank: number }) {
  const changeColor =
    ex.volumeChange24h == null
      ? TEXT_DIM
      : ex.volumeChange24h >= 0
        ? ZEC
        : RED
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: `1px solid ${DIVIDER}`,
        paddingBottom: "9px",
        gap: "14px",
        fontSize: "20px",
      }}
    >
      <span style={{ display: "flex", width: "34px", color: TEXT_DIM }}>
        {rank}
      </span>
      <span
        style={{
          display: "flex",
          flex: 1,
          color: TEXT,
          fontWeight: 800,
          minWidth: 0,
        }}
      >
        {ex.exchange}
      </span>
      <span
        style={{
          display: "flex",
          width: "84px",
          justifyContent: "flex-end",
          color: ZEC,
          fontWeight: 800,
        }}
      >
        {fmtShare(ex.share)}
      </span>
      <span
        style={{
          display: "flex",
          width: "112px",
          justifyContent: "flex-end",
          color: TEXT_DIM,
        }}
      >
        {fmtCompactUSD(ex.volumeUsd24h)}
      </span>
      <span
        style={{
          display: "flex",
          width: "86px",
          justifyContent: "flex-end",
          color: changeColor,
          fontWeight: 800,
        }}
      >
        {fmtChange(ex.volumeChange24h)}
      </span>
    </div>
  )
}

function PairRow({ pair }: { pair: PairLite }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: `1px solid ${DIVIDER}`,
        paddingBottom: "8px",
        gap: "12px",
        fontSize: "19px",
      }}
    >
      <span style={{ display: "flex", color: TEXT, fontWeight: 800 }}>
        {pair.pair}
      </span>
      <span style={{ display: "flex", color: RATIO }}>
        {fmtShare(pair.share)} / {fmtCompactUSD(pair.volumeUsd24h)}
      </span>
    </div>
  )
}
