"use client"

import Link from "next/link"
import useSWR from "swr"
import type {
  OrchardRiskHistoryPoint,
  OrchardRiskResponse,
} from "./api-types"
import { fmtCompactUSD, swrFetcher } from "./format"
import { CornerBox, Skeleton } from "./primitives"
import { ShareButton } from "./share-button"
import { E_STATIC, paletteVar } from "./theme"

function fmtOdds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${Math.round(value * 100)}%`
}

function fmtCents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${Math.round(value * 100)}c`
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "--"
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
}

function useOrchardRisk() {
  return useSWR<OrchardRiskResponse>("/api/orchard-risk", swrFetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  })
}

function OddsBar({ yes }: { yes: number | null }) {
  const yesPct =
    yes == null || !Number.isFinite(yes)
      ? 0
      : Math.max(0, Math.min(100, yes * 100))
  const noPct = Math.max(0, 100 - yesPct)
  return (
    <div
      className="h-2 overflow-hidden"
      style={{ background: `${paletteVar("text")}12` }}
    >
      <div className="flex h-full">
        <div
          className="h-full"
          style={{
            width: `${yesPct}%`,
            background: E_STATIC.red,
            boxShadow: `0 0 8px ${E_STATIC.red}55`,
          }}
        />
        <div
          className="h-full"
          style={{
            width: `${noPct}%`,
            background: paletteVar("cyph"),
            boxShadow: `0 0 8px ${paletteVar("cyph")}55`,
          }}
        />
      </div>
    </div>
  )
}

export function OrchardRiskStrip() {
  const { data, error, isLoading } = useOrchardRisk()

  if (isLoading && !data) return <Skeleton height={44} />
  if (error && !data) return null
  if (!data) return null

  return (
    <Link href="/orchard-risk" className="block mb-2 md:mb-3">
      <div
        className="grid grid-cols-[1fr_auto] items-center gap-3 px-2.5 py-2 text-[11px] md:text-[11px]"
        style={{
          border: `1px solid ${E_STATIC.red}44`,
          background: `${E_STATIC.red}08`,
          color: paletteVar("text"),
        }}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span
              className="font-bold tracking-[0.18em]"
              style={{ color: E_STATIC.red }}
            >
              ORCHARD RISK
            </span>
            <span style={{ opacity: 0.6 }}>Polymarket</span>
            {data.stale && (
              <span style={{ color: E_STATIC.red, opacity: 0.85 }}>STALE</span>
            )}
          </div>
          <div className="mt-1">
            <OddsBar yes={data.yesPrice} />
          </div>
        </div>
        <div className="text-right tabular-nums">
          <div
            className="text-lg md:text-xl font-bold leading-none"
            style={{ color: E_STATIC.red, textShadow: `0 0 8px ${E_STATIC.red}55` }}
          >
            {fmtOdds(data.yesPrice)}
          </div>
          <div className="mt-0.5 tracking-[0.12em]" style={{ opacity: 0.62 }}>
            YES
          </div>
        </div>
      </div>
    </Link>
  )
}

export function OrchardRiskPill() {
  const { data, error } = useOrchardRisk()

  if (error || !data) return null

  return (
    <Link
      href="/orchard-risk"
      className="block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
      style={{ outlineColor: E_STATIC.red }}
      title="Open Orchard risk market"
    >
      <div
        className="grid grid-cols-[1fr_auto] items-center gap-2 px-2 py-1.5 text-[10px]"
        style={{
          border: `1px solid ${E_STATIC.red}44`,
          background: `${E_STATIC.red}08`,
        }}
      >
        <div className="min-w-0">
          <div
            className="font-bold tracking-[0.18em] truncate"
            style={{ color: E_STATIC.red }}
          >
            ORCHARD RISK
          </div>
          <div
            className="mt-0.5 truncate"
            style={{ color: paletteVar("text"), opacity: 0.58 }}
          >
            Polymarket signal
          </div>
        </div>
        <div
          className="text-right font-bold tabular-nums"
          style={{ color: E_STATIC.red }}
        >
          <span className="text-sm leading-none">{fmtOdds(data.yesPrice)}</span>
          <span
            className="ml-1 tracking-[0.14em]"
            style={{ color: paletteVar("text"), opacity: 0.62 }}
          >
            YES
          </span>
        </div>
      </div>
    </Link>
  )
}

function RiskChart({ history }: { history: OrchardRiskHistoryPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="py-10 text-center text-[11px]" style={{ opacity: 0.6 }}>
        Price history is still warming up.
      </div>
    )
  }

  const minT = history[0].timestamp
  const maxT = history[history.length - 1].timestamp
  const width = 100
  const height = 44
  const pad = 3
  const points = history
    .map((point) => {
      const x =
        maxT === minT
          ? pad
          : pad + ((point.timestamp - minT) / (maxT - minT)) * (width - pad * 2)
      const y = pad + (1 - point.price) * (height - pad * 2)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(" ")
  const latest = history[history.length - 1]

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full"
        role="img"
        aria-label="Polymarket yes price history"
      >
        {[0.25, 0.5, 0.75].map((level) => {
          const y = pad + (1 - level) * (height - pad * 2)
          return (
            <line
              key={level}
              x1={pad}
              x2={width - pad}
              y1={y}
              y2={y}
              stroke={`${paletteVar("text")}22`}
              strokeDasharray="1 2"
            />
          )
        })}
        <polyline
          points={points}
          fill="none"
          stroke={E_STATIC.red}
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={
            maxT === minT
              ? pad
              : pad + ((latest.timestamp - minT) / (maxT - minT)) * (width - pad * 2)
          }
          cy={pad + (1 - latest.price) * (height - pad * 2)}
          r="1.4"
          fill={E_STATIC.red}
        />
      </svg>
      <div
        className="absolute left-2 top-2 text-[10px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        YES PRICE
      </div>
      <div
        className="absolute right-2 top-2 text-[10px] tabular-nums"
        style={{ color: E_STATIC.red }}
      >
        {fmtOdds(latest.price)}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <div
      className="min-w-0 px-2 py-2"
      style={{
        border: `1px solid ${(color ?? paletteVar("text"))}33`,
        background: `${color ?? paletteVar("text")}08`,
      }}
    >
      <div
        className="truncate text-[9px] md:text-[10px] tracking-[0.18em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {label}
      </div>
      <div
        className="mt-1 truncate text-sm md:text-base font-bold tabular-nums"
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

export function OrchardRiskDetails() {
  const { data, error, isLoading } = useOrchardRisk()

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton height={96} />
        <Skeleton height={260} />
        <Skeleton height={160} />
      </div>
    )
  }

  if (error && !data) {
    return (
      <CornerBox label="ORCHARD RISK" color={E_STATIC.red}>
        <div className="text-sm" style={{ color: E_STATIC.red }}>
          Polymarket signal unavailable.
        </div>
      </CornerBox>
    )
  }

  if (!data) return null

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="flex min-w-0 items-start justify-between gap-3 md:block">
          <div className="min-w-0">
            <h1
              className="text-base md:text-lg font-bold tracking-[0.22em]"
              style={{ color: E_STATIC.red }}
            >
              ORCHARD RISK MARKET
            </h1>
            <div
              className="mt-1 max-w-3xl text-[11px] leading-snug"
              style={{ color: paletteVar("text"), opacity: 0.68 }}
            >
              Polymarket implied probability that the June 4 Orchard
              vulnerability is confirmed exploited on mainnet. Market signal,
              not protocol evidence.
            </div>
          </div>
          <div className="md:hidden">
            <ShareButton
              tweetText="$ZEC Orchard risk market - Polymarket odds for exploit confirmation:"
              ogImagePath="/api/og/orchard-risk"
              pngFileName="orchard-risk-market.png"
              shareUrl="https://cyphzec.com/orchard-risk"
              xCacheBust
              ariaLabel="Share Orchard risk market"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 md:ml-auto">
          <div className="hidden md:block">
            <ShareButton
              tweetText="$ZEC Orchard risk market - Polymarket odds for exploit confirmation:"
              ogImagePath="/api/og/orchard-risk"
              pngFileName="orchard-risk-market.png"
              shareUrl="https://cyphzec.com/orchard-risk"
              xCacheBust
              ariaLabel="Share Orchard risk market"
            />
          </div>
          <Link
            href={data.url}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 text-[11px] tracking-[0.14em] md:whitespace-nowrap"
            style={{
              color: paletteVar("cyph"),
              border: `1px solid ${paletteVar("cyph")}55`,
            }}
          >
            POLYMARKET -&gt;
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-[0.85fr_1.35fr] gap-3 mb-3">
        <CornerBox label="CURRENT ODDS" color={E_STATIC.red}>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div
                className="text-[10px] tracking-[0.18em]"
                style={{ color: paletteVar("text"), opacity: 0.62 }}
              >
                YES
              </div>
              <div
                className="mt-1 text-5xl font-bold tabular-nums leading-none"
                style={{ color: E_STATIC.red, textShadow: `0 0 12px ${E_STATIC.red}55` }}
              >
                {fmtOdds(data.yesPrice)}
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-[10px] tracking-[0.18em]"
                style={{ color: paletteVar("text"), opacity: 0.62 }}
              >
                NO
              </div>
              <div
                className="mt-1 text-2xl font-bold tabular-nums"
                style={{ color: paletteVar("cyph") }}
              >
                {fmtOdds(data.noPrice)}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <OddsBar yes={data.yesPrice} />
          </div>
          <div
            className="mt-3 grid grid-cols-3 gap-2 text-[11px] tabular-nums"
            style={{ color: paletteVar("text") }}
          >
            <Stat label="BID" value={fmtCents(data.yesBid)} color={paletteVar("cyph")} />
            <Stat label="ASK" value={fmtCents(data.yesAsk)} color={E_STATIC.red} />
            <Stat label="SPREAD" value={fmtCents(data.spread)} />
          </div>
        </CornerBox>

        <CornerBox label="YES PRICE HISTORY" color={E_STATIC.red}>
          <RiskChart history={data.history} />
        </CornerBox>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <Stat label="VOLUME" value={fmtCompactUSD(data.volume)} color={paletteVar("zec")} />
        <Stat label="24H VOL" value={fmtCompactUSD(data.volume24h)} color={paletteVar("zec")} />
        <Stat label="LIQUIDITY" value={fmtCompactUSD(data.liquidity)} color={paletteVar("cyph")} />
        <Stat label="CLOSE" value={fmtDate(data.endDate)} color={paletteVar("ratio")} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-3">
        <CornerBox label="RESOLUTION FRAME" color={paletteVar("text")}>
          <div
            className="space-y-2 text-[11px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.72 }}
          >
            <p>
              Resolves YES if Shielded Labs, the Zcash Foundation, ZODL, or
              overwhelming credible reporting confirms the Orchard pool bug was
              exploited on Zcash mainnet before the fix.
            </p>
            <p>
              Qualifying signals include unauthorized or unbacked ZEC creation,
              or a turnstile/accounting process that attributes excess Orchard
              value to this vulnerability.
            </p>
          </div>
        </CornerBox>

        <CornerBox label="SOURCE" color={paletteVar("ratio")}>
          <div className="space-y-2 text-[11px]" style={{ color: paletteVar("text") }}>
            <div>
              <div style={{ opacity: 0.55 }}>UPDATED</div>
              <div style={{ color: paletteVar("cyph") }}>
                {fmtDate(data.updatedAt)}
              </div>
            </div>
            <div>
              <div style={{ opacity: 0.55 }}>FETCHED</div>
              <div style={{ color: paletteVar("zec") }}>
                {fmtDate(new Date(data.fetchedAt).toISOString())}
              </div>
            </div>
            {data.stale && (
              <div style={{ color: E_STATIC.red }}>serving stale cache</div>
            )}
          </div>
        </CornerBox>
      </section>
    </>
  )
}
