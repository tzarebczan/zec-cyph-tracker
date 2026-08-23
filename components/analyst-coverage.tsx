"use client"

import { useState } from "react"
import { TrendingDown, TrendingUp } from "lucide-react"
import useSWR from "swr"
import type {
  AnalystAction,
  AnalystRating,
  CyphAnalystsResponse,
} from "@/app/api/cyph-analysts/route"
import { CornerBox, InfoTip, Skeleton } from "./primitives"
import { swrFetcher } from "./format"
import { paletteVar, E_STATIC } from "./theme"

type View = "latest" | "all"

const ACTION_LABEL: Record<AnalystAction, string> = {
  upgrade: "UPGRADE",
  downgrade: "DOWNGRADE",
  initiate: "INITIATE",
  maintain: "MAINTAIN",
  reiterate: "REITERATE",
}

function actionColor(rating: AnalystRating): string {
  if (rating.action === "upgrade") return paletteVar("cyph")
  if (rating.action === "downgrade") return E_STATIC.red
  // A maintain that moved the target still carries direction.
  if (rating.priceTargetChangePct != null) {
    return rating.priceTargetChangePct >= 0
      ? paletteVar("cyph")
      : E_STATIC.red
  }
  return paletteVar("amber")
}

function fmtUsd(value: number | null): string {
  if (value == null) return "—"
  return `$${value.toFixed(2)}`
}

function fmtPct(value: number | null): string {
  if (value == null) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

function fmtDate(ms: number, withYear = false): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
    .format(new Date(ms))
    .toUpperCase()
}

export function AnalystCoverage({
  cyphPrice,
  className,
}: {
  cyphPrice: number | null
  /** Grid placement / visibility from the caller, same contract as
   *  MiningPanel — /holdings groups its cards into mobile tabs and needs to
   *  be able to hide this one. */
  className?: string
}) {
  const { data, error } = useSWR<CyphAnalystsResponse>(
    "/api/cyph-analysts",
    swrFetcher,
    { refreshInterval: 15 * 60_000, keepPreviousData: true }
  )
  const [view, setView] = useState<View>("latest")

  if (!data && !error) {
    return (
      <CornerBox label="ANALYST COVERAGE" color={paletteVar("cyph")} className={className}>
        <Skeleton className="mt-2" height={110} />
      </CornerBox>
    )
  }
  // No coverage is a legitimate state for a micro-cap; don't render an empty
  // card claiming otherwise.
  if (!data || !data.ratings.length) return null

  const latest = data.latest
  const target = data.latestPriceTarget
  const upside =
    target != null && cyphPrice != null && cyphPrice > 0
      ? ((target - cyphPrice) / cyphPrice) * 100
      : null

  return (
    <CornerBox
      label="ANALYST COVERAGE"
      color={paletteVar("cyph")}
      className={className}
      action={
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex border" style={{ borderColor: `${paletteVar("cyph")}44` }}>
            {(["latest", "all"] as const).map((id) => {
              const active = view === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={active}
                  className="min-h-5 px-1.5 text-[8px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1"
                  style={{
                    color: active ? "#030706" : paletteVar("text"),
                    background: active ? paletteVar("cyph") : "transparent",
                    opacity: active ? 1 : 0.6,
                    outlineColor: paletteVar("cyph"),
                  }}
                >
                  {id === "latest" ? "LATEST" : `ALL ${data.ratings.length}`}
                </button>
              )
            })}
          </span>
          <InfoTip color={paletteVar("cyph")} label="About analyst coverage" size={13}>
            <p>
              Rating actions and price targets from Yahoo Finance&rsquo;s
              coverage feed.
            </p>
            <p className="mt-2">
              The headline target is taken from the most recent rating action,
              not Yahoo&rsquo;s consensus field — that consensus lags, and still
              read {fmtUsd(data.consensus.targetMean)} while the newest action
              on file was {fmtUsd(target)}.
            </p>
            {data.stale && (
              <p className="mt-2">
                Showing the last good snapshot; the live fetch failed.
              </p>
            )}
          </InfoTip>
        </span>
      }
    >
      {view === "latest" && latest ? (
        <>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div>
              <div className="text-[9px] tracking-[0.16em]" style={{ opacity: 0.55 }}>
                PRICE TARGET
              </div>
              <div
                className="mt-0.5 text-2xl font-bold tabular-nums md:text-3xl"
                style={{ color: paletteVar("cyph") }}
              >
                {fmtUsd(target)}
              </div>
            </div>
            {upside != null && (
              <div className="text-[11px] tabular-nums" style={{ color: upside >= 0 ? paletteVar("cyph") : E_STATIC.red }}>
                {upside >= 0 ? (
                  <TrendingUp aria-hidden="true" size={12} className="mb-0.5 inline" />
                ) : (
                  <TrendingDown aria-hidden="true" size={12} className="mb-0.5 inline" />
                )}{" "}
                {fmtPct(upside)} vs {fmtUsd(cyphPrice)}
              </div>
            )}
          </div>

          <div
            className="mt-3 border-t pt-2"
            style={{ borderColor: `${paletteVar("cyph")}22` }}
          >
            <RatingLine rating={latest} />
          </div>

          <div
            className="mt-2 flex flex-wrap justify-between gap-2 text-[9px] tracking-[0.12em]"
            style={{ opacity: 0.5 }}
          >
            <span>
              {data.firmCount} COVERING FIRM{data.firmCount === 1 ? "" : "S"}
            </span>
            <span>
              {[
                data.consensus.strongBuy ? `${data.consensus.strongBuy} STRONG BUY` : null,
                data.consensus.buy ? `${data.consensus.buy} BUY` : null,
                data.consensus.hold ? `${data.consensus.hold} HOLD` : null,
                data.consensus.sell ? `${data.consensus.sell} SELL` : null,
              ]
                .filter(Boolean)
                .join(" · ") || ""}
            </span>
          </div>
        </>
      ) : (
        <div className="mt-2 divide-y" style={{ borderColor: `${paletteVar("cyph")}1e` }}>
          {data.ratings.map((rating) => (
            <div key={`${rating.date}-${rating.firm}`} className="py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[9px] tabular-nums" style={{ opacity: 0.55 }}>
                  {fmtDate(rating.date, true)}
                </span>
                <span
                  className="text-[8px] font-bold tracking-[0.12em]"
                  style={{ color: actionColor(rating) }}
                >
                  {ACTION_LABEL[rating.action]}
                </span>
              </div>
              <RatingLine rating={rating} compact />
            </div>
          ))}
        </div>
      )}
    </CornerBox>
  )
}

function RatingLine({
  rating,
  compact = false,
}: {
  rating: AnalystRating
  compact?: boolean
}) {
  const moved =
    rating.priorPriceTarget != null &&
    rating.priceTarget != null &&
    rating.priorPriceTarget !== rating.priceTarget
  return (
    <div className={compact ? "mt-0.5" : ""}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] font-bold tracking-[0.08em]">
          {rating.firm}
        </span>
        {rating.toGrade && (
          <span
            className="text-[9px] font-bold tracking-[0.12em]"
            style={{ color: paletteVar("cyph") }}
          >
            {rating.fromGrade && rating.fromGrade !== rating.toGrade
              ? `${rating.fromGrade.toUpperCase()} → ${rating.toGrade.toUpperCase()}`
              : rating.toGrade.toUpperCase()}
          </span>
        )}
        {!compact && (
          <span className="text-[9px] tabular-nums" style={{ opacity: 0.5 }}>
            {fmtDate(rating.date)}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums" style={{ opacity: 0.72 }}>
        {moved ? (
          <>
            TARGET {rating.priceTargetChangePct != null && rating.priceTargetChangePct >= 0 ? "RAISED" : "CUT"}{" "}
            {fmtUsd(rating.priorPriceTarget)} → {fmtUsd(rating.priceTarget)}
            <span
              className="ml-1"
              style={{
                color:
                  (rating.priceTargetChangePct ?? 0) >= 0
                    ? paletteVar("cyph")
                    : E_STATIC.red,
              }}
            >
              {fmtPct(rating.priceTargetChangePct)}
            </span>
          </>
        ) : rating.priceTarget != null ? (
          <>TARGET {fmtUsd(rating.priceTarget)}</>
        ) : (
          <>NO PRICE TARGET</>
        )}
        {/* The distinction that matters: a target move under an unchanged
            rating is not an upgrade. */}
        {rating.targetOnlyMove && (
          <span className="ml-1" style={{ opacity: 0.6 }}>
            · RATING UNCHANGED
          </span>
        )}
      </div>
    </div>
  )
}
