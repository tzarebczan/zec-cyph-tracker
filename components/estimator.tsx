"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { usePersistentState } from "@/lib/use-persistent-state"
import { CornerBox } from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import type {
  HoldingsResponse,
  PricesResponse,
  QuoteSnapshot,
} from "./api-types"

type RatioMode = "live" | "24h" | "7d" | "30d" | "3m"

function isValidEstimatorRatioMode(v: unknown): v is RatioMode {
  return v === "live" || v === "24h" || v === "7d" || v === "30d" || v === "3m"
}

export function Estimator() {
  const [zecTarget, setZecTarget] = useState<number>(500)
  const [ratioMode, setRatioMode] = usePersistentState<RatioMode>(
    "cyphzec.estimator.ratio.mode",
    "live",
    isValidEstimatorRatioMode
  )

  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=90",
    swrFetcher,
    {
      refreshInterval: 60_000,
      keepPreviousData: true,
    }
  )
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )

  // Reference-period modes use the most recent daily closing prices so
  // pre-market / after-hours / overnight prints don't skew the estimate.
  // Only LIVE taps the realtime/extended-hours quote stream.
  const history = prices?.history ?? []
  const lastCloseCyph = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const v = history[i].cyph
      if (v != null && Number.isFinite(v)) return v
    }
    return null
  }, [history])
  const liveCyphPrice = pickLiveCyph(quote)
  const liveZecPrice = prices?.current?.zec?.price ?? null
  const liveRatio =
    liveCyphPrice != null && liveZecPrice != null && liveZecPrice > 0
      ? liveCyphPrice / liveZecPrice
      : null

  const cyphPrice = ratioMode === "live" ? liveCyphPrice : lastCloseCyph

  const ratios: Record<RatioMode, number | null> = {
    live: liveRatio,
    "24h": prices?.stats?.ratio.avg24h ?? null,
    "7d": prices?.stats?.ratio.avg7d ?? null,
    "30d": prices?.stats?.ratio.avg30d ?? null,
    "3m": prices?.stats?.ratio.avg3m ?? null,
  }
  const r = ratios[ratioMode]
  const predicted = r != null ? zecTarget * r : null
  const upside =
    predicted != null && cyphPrice != null && cyphPrice > 0
      ? ((predicted / cyphPrice) - 1) * 100
      : null

  const totalZec = holdings?.summary.totalZec ?? null
  const sharesOutstanding = quote?.sharesOutstanding ?? null
  const treasuryAtTarget =
    totalZec != null ? totalZec * zecTarget : null
  const navPerShareAtTarget =
    treasuryAtTarget != null && sharesOutstanding && sharesOutstanding > 0
      ? treasuryAtTarget / sharesOutstanding
      : null

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">
          [ $CYPH ESTIMATOR ]
        </h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          predict CYPH for any future ZEC price
        </span>
      </div>

      <CornerBox color={paletteVar("cyph")} className="mb-3">
        <div
          className="text-[10px] tracking-[0.3em]"
          style={{ color: paletteVar("zec") }}
        >
          IF $ZEC REACHES…
        </div>
        <div className="flex items-baseline gap-2 mt-1">
          <span
            className="font-bold text-2xl"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            $
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            value={zecTarget || ""}
            onChange={(e) => setZecTarget(parseFloat(e.target.value) || 0)}
            aria-label="ZEC target price"
            className="flex-1 bg-transparent font-bold text-4xl md:text-6xl tabular-nums outline-none w-full"
            style={{
              color: paletteVar("zec"),
              textShadow: `0 0 12px ${paletteVar("zec")}55`,
              borderBottom: `2px solid ${paletteVar("zec")}55`,
              caretColor: paletteVar("zec"),
            }}
          />
        </div>
        <input
          type="range"
          min={50}
          max={5000}
          step={10}
          value={Math.max(50, Math.min(5000, zecTarget))}
          onChange={(e) => setZecTarget(parseFloat(e.target.value))}
          aria-label="ZEC target slider"
          className="w-full mt-4"
          style={{ accentColor: paletteVar("zec") }}
        />
        <div
          className="flex justify-between text-[10px] mt-1"
          style={{ color: paletteVar("text"), opacity: 0.5 }}
        >
          <span>$50</span>
          <span>$1,000</span>
          <span>$2,500</span>
          <span>$5,000</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 mt-5">
          <div className="text-center">
            <div
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              ZEC TARGET
            </div>
            <div
              className="text-xl font-bold tabular-nums"
              style={{ color: paletteVar("zec") }}
            >
              ${zecTarget.toLocaleString("en-US")}
            </div>
          </div>
          <div
            className="hidden sm:block text-center text-[14px]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            ×
          </div>
          <div className="text-center">
            <div
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              RATIO
            </div>
            <div
              className="text-xl font-bold tabular-nums"
              style={{ color: paletteVar("ratio") }}
            >
              {r != null ? r.toPrecision(4) : "—"}
            </div>
            <div className="flex gap-1 mt-1 justify-center flex-wrap">
              {(
                [
                  ["live", "LIVE"],
                  ["24h", "24H"],
                  ["7d", "7D"],
                  ["30d", "1M"],
                  ["3m", "3M"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRatioMode(k)}
                  className="text-[9px] px-1 transition-colors"
                  style={{
                    color:
                      ratioMode === k
                        ? paletteVar("ratio")
                        : paletteVar("text"),
                    opacity: ratioMode === k ? 1 : 0.5,
                  }}
                >
                  [{ratioMode === k ? "■" : " "}
                  {label}]
                </button>
              ))}
            </div>
            <div
              className="text-[9px] mt-1 tracking-wider tabular-nums"
              style={{
                color:
                  ratioMode === "live"
                    ? paletteVar("cyph")
                    : paletteVar("ratio"),
                opacity: 0.6,
              }}
            >
              {ratioMode === "live"
                ? "REAL-TIME / EXTENDED HOURS"
                : "DAILY CLOSING PRICES ONLY"}
            </div>
          </div>
          <div
            className="hidden sm:block text-center text-[14px]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            =
          </div>
          <div className="text-center">
            <div
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              $CYPH ≈
            </div>
            <div
              className="text-2xl md:text-3xl font-bold tabular-nums"
              style={{
                color: paletteVar("cyph"),
                textShadow: `0 0 12px ${paletteVar("cyph")}55`,
              }}
            >
              {predicted != null ? "$" + predicted.toFixed(2) : "—"}
            </div>
            {upside != null && cyphPrice != null && (
              <div
                className="text-[10px] tabular-nums mt-0.5"
                style={{ color: upside >= 0 ? paletteVar("cyph") : E_STATIC.red }}
              >
                {upside >= 0 ? "▲" : "▼"} {Math.abs(upside).toFixed(1)}% vs $
                {cyphPrice.toFixed(2)}
              </div>
            )}
          </div>
        </div>
      </CornerBox>

      {totalZec != null && (
        <CornerBox
          label="TREASURY VALUE AT THIS ZEC PRICE"
          color={paletteVar("amber")}
          className="mb-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div
                className="text-[10px]"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                {Math.round(totalZec).toLocaleString("en-US")} ZEC × $
                {zecTarget.toLocaleString("en-US")}
              </div>
              <div
                className="text-2xl md:text-3xl font-bold tabular-nums"
                style={{ color: paletteVar("amber") }}
              >
                {fmtCompactUSD(treasuryAtTarget)}
              </div>
            </div>
            {navPerShareAtTarget != null && (
              <div>
                <div
                  className="text-[10px]"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  WORTH PER CYPH SHARE*
                </div>
                <div
                  className="text-2xl md:text-3xl font-bold tabular-nums"
                  style={{ color: paletteVar("ratio") }}
                >
                  ${navPerShareAtTarget.toFixed(2)}
                </div>
              </div>
            )}
          </div>
          {navPerShareAtTarget != null && sharesOutstanding != null && (
            <div
              className="mt-3 text-[9px] tracking-[0.12em] tabular-nums"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              * NAV/share uses {fmtCompactNumber(sharesOutstanding)} CYPH
              shares outstanding.
            </div>
          )}
        </CornerBox>
      )}

      <CornerBox label="COMMON SCENARIOS">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[200, 500, 1000, 2500].map((z) => {
            const c = r != null ? z * r : null
            const ready = c != null
            return (
              <button
                key={z}
                type="button"
                onClick={() => setZecTarget(z)}
                disabled={!ready}
                aria-disabled={!ready}
                className="text-left px-3 py-2.5 border transition-colors hover:bg-emerald-950/30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                style={{
                  borderColor: `${paletteVar("text")}33`,
                  opacity: ready ? 1 : 0.5,
                }}
              >
                <div className="text-[10px]" style={{ color: paletteVar("zec") }}>
                  ZEC ${z}
                </div>
                <div
                  className="text-xl font-bold tabular-nums"
                  style={{ color: paletteVar("cyph") }}
                >
                  {ready ? "$" + c!.toFixed(2) : "—"}
                </div>
                <div
                  className="text-[9px]"
                  style={{ color: paletteVar("text"), opacity: 0.5 }}
                >
                  {ready ? "CYPH estimate" : "loading ratio…"}
                </div>
              </button>
            )
          })}
        </div>
      </CornerBox>
    </>
  )
}
