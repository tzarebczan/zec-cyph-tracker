"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  CornerBox,
  LiveNumber,
  SingleLineChartE,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtUSD, fmtCompactUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import {
  computePortfolioMetrics,
  hasPortfolioData,
  usePortfolioState,
  type PortfolioWindow,
} from "./portfolio-state"
import type { PricesHistoryPoint, PricesResponse, QuoteSnapshot } from "./api-types"

const WINDOW_OPTIONS: PortfolioWindow[] = ["1D", "1W", "1M", "3M", "6M"]
const WINDOW_DAYS: Record<PortfolioWindow, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
}

function asInputValue(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) || v === 0 ? "" : String(v)
}

function parseInputValue(v: string, nullable = false): number | null {
  if (v.trim() === "") return nullable ? null : 0
  const parsed = Number(v)
  if (!Number.isFinite(parsed) || parsed < 0) return nullable ? null : 0
  return parsed
}

function fmtSignedUSD(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--"
  const sign = n >= 0 ? "+" : "-"
  return `${sign}${fmtUSD(Math.abs(n))}`
}

function fmtSignedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--"
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`
}

function toneColor(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
}

function previousCloseFromHistory(
  history: PricesHistoryPoint[],
  key: "cyph" | "zec"
): number | null {
  const today = new Date().toISOString().slice(0, 10)
  const point = [...history]
    .reverse()
    .find((row) => {
      const value = row[key]
      return row.date < today && value != null && Number.isFinite(value)
    })
  return point?.[key] ?? null
}

function filterChartWindow(
  data: { date: string; value: number }[],
  window: PortfolioWindow
) {
  if (window === "6M") return data
  const cutoff = Date.now() - WINDOW_DAYS[window] * 86400_000
  return data.filter((point) => {
    const ms = Date.parse(point.date)
    return Number.isFinite(ms) && ms >= cutoff
  })
}

export function Portfolio() {
  const [portfolio, setPortfolio, saved] = usePortfolioState()
  const [window, setWindow] = useState<PortfolioWindow>("1M")

  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=180",
    swrFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })

  const history = useMemo(() => prices?.history ?? [], [prices])
  const cyphPrice = pickLiveCyph(quote) ?? prices?.current?.cyph?.price ?? null
  const zecPrice = prices?.current?.zec?.price ?? null
  const cyphPreviousClose =
    quote?.regularMarketPreviousClose ?? previousCloseFromHistory(history, "cyph")
  const zecPreviousClose = previousCloseFromHistory(history, "zec")

  const metrics = useMemo(
    () =>
      computePortfolioMetrics({
        state: portfolio,
        cyphPrice,
        zecPrice,
        cyphPreviousClose,
        zecPreviousClose,
        history,
      }),
    [portfolio, cyphPrice, zecPrice, cyphPreviousClose, zecPreviousClose, history]
  )

  const hasData = hasPortfolioData(portfolio)
  const activeWindow = metrics.windows.find((row) => row.key === window)
  const chartData = filterChartWindow(metrics.history, window)

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-base font-bold tracking-[0.2em]">PORTFOLIO</h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          private - on-device only
        </span>
        <span
          className="ml-auto hidden items-center gap-1.5 px-2 py-0.5 text-[10px] transition-opacity sm:inline-flex"
          style={{
            color: paletteVar("ratio"),
            border: `1px solid ${paletteVar("ratio")}55`,
            opacity: saved ? 1 : 0.55,
          }}
        >
          LOCK {saved ? "SAVED" : "ON-DEVICE"}
        </span>
      </div>

      <CornerBox label="PORTFOLIO VALUE" color={paletteVar("ratio")} className="mb-3">
        <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_0.9fr]">
          <div>
            <div
              className="text-[10px] tracking-[0.18em]"
              style={{ color: paletteVar("text"), opacity: 0.62 }}
            >
              NET VALUE - LIVE
            </div>
            <div className="mt-1 text-4xl font-bold leading-none md:text-5xl">
              <LiveNumber
                value={metrics.totalValue}
                format={fmtUSD}
                color={paletteVar("ratio")}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] md:max-w-md">
              <DeltaLine label="DAILY" value={metrics.dailyChange} pct={metrics.dailyChangePct} />
              <DeltaLine label="VS AVG COST" value={metrics.totalPnl} pct={metrics.totalPnlPct} />
            </div>
          </div>

          <LivePricePanel
            label="CYPH LIVE"
            price={cyphPrice}
            previousClose={cyphPreviousClose}
            color={paletteVar("cyph")}
          />
          <LivePricePanel
            label="ZEC LIVE"
            price={zecPrice}
            previousClose={zecPreviousClose}
            color={paletteVar("zec")}
          />
          <div
            className="border px-3 py-2"
            style={{ borderColor: `${paletteVar("text")}22` }}
          >
            <div
              className="text-[10px] tracking-[0.18em]"
              style={{ color: paletteVar("text"), opacity: 0.62 }}
            >
              COST BASIS
            </div>
            <div
              className="mt-1 text-2xl font-bold tabular-nums"
              style={{
                color: metrics.costBasisComplete
                  ? toneColor(metrics.totalPnl)
                  : paletteVar("amber"),
              }}
            >
              {metrics.totalCost != null ? fmtUSD(metrics.totalCost) : "SET AVG COSTS"}
            </div>
            <div
              className="mt-1 text-[10px] leading-relaxed"
              style={{ color: paletteVar("text"), opacity: 0.58 }}
            >
              Total change compares live value against CYPH avg/share and ZEC avg/ZEC.
            </div>
          </div>
        </div>
      </CornerBox>

      <section className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <PositionCard
          asset="CYPH"
          color={paletteVar("cyph")}
          quantity={portfolio.cyphShares}
          quantityLabel="shares"
          price={cyphPrice}
          value={metrics.cyphValue}
          avgCost={portfolio.cyphAvgCost}
        />
        <PositionCard
          asset="ZEC"
          color={paletteVar("zec")}
          quantity={portfolio.zecCoins}
          quantityLabel="ZEC"
          price={zecPrice}
          value={metrics.zecValue}
          avgCost={portfolio.zecAvgCost}
        />
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[340px_1fr]">
        <CornerBox label="HOLDINGS">
          <div className="grid grid-cols-1 gap-3">
            <InputRow
              label="CYPH SHARES"
              color={paletteVar("cyph")}
              value={portfolio.cyphShares}
              onChange={(value) => setPortfolio("cyphShares", value ?? 0)}
              suffix="CYPH"
            />
            <InputRow
              label="CYPH AVG COST"
              color={paletteVar("cyph")}
              value={portfolio.cyphAvgCost}
              onChange={(value) => setPortfolio("cyphAvgCost", value)}
              suffix="USD/SHARE"
              nullable
            />
            <InputRow
              label="ZEC AMOUNT"
              color={paletteVar("zec")}
              value={portfolio.zecCoins}
              onChange={(value) => setPortfolio("zecCoins", value ?? 0)}
              suffix="ZEC"
            />
            <InputRow
              label="ZEC AVG COST"
              color={paletteVar("zec")}
              value={portfolio.zecAvgCost}
              onChange={(value) => setPortfolio("zecAvgCost", value)}
              suffix="USD/ZEC"
              nullable
            />
          </div>
          <p
            className="mt-3 text-[10px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.52 }}
          >
            Stored only in this browser. Cost basis is average entry price per asset,
            not total dollars invested.
          </p>
        </CornerBox>

        <CornerBox
          label={`PERFORMANCE - ${window}`}
          action={
            <div className="flex gap-1">
              {WINDOW_OPTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWindow(key)}
                  className="px-2 py-0.5 text-[10px] font-bold tracking-[0.12em] transition-colors"
                  style={{
                    color: window === key ? "#000" : paletteVar("text"),
                    background: window === key ? paletteVar("ratio") : "transparent",
                    border: `1px solid ${window === key ? paletteVar("ratio") : `${paletteVar("text")}33`}`,
                  }}
                >
                  {key}
                </button>
              ))}
            </div>
          }
        >
          {!hasData ? (
            <div
              className="flex min-h-[260px] flex-col items-center justify-center text-center"
              style={{ color: paletteVar("text"), opacity: 0.58 }}
            >
              <div className="text-[12px] font-bold tracking-[0.2em]">
                ENTER HOLDINGS
              </div>
              <div className="mt-1 text-[11px]">
                Add CYPH shares or ZEC above to chart portfolio value.
              </div>
            </div>
          ) : chartData.length >= 2 ? (
            <>
              <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-5">
                {metrics.windows.map((row) => (
                  <WindowCell key={row.key} row={row} active={row.key === window} />
                ))}
              </div>
              <SingleLineChartE
                data={chartData}
                height={260}
                color={paletteVar("ratio")}
                valueFormat={fmtUSD}
                emptyMessage="Need more price history."
              />
              <div
                className="mt-2 text-[10px]"
                style={{ color: paletteVar("text"), opacity: 0.55 }}
              >
                {activeWindow?.baseline != null
                  ? `${window} baseline ${fmtUSD(activeWindow.baseline)}`
                  : "Window baseline unavailable until price history fills in."}
              </div>
            </>
          ) : (
            <div
              className="flex min-h-[260px] items-center justify-center text-[11px]"
              style={{ color: paletteVar("text"), opacity: 0.58 }}
            >
              Loading portfolio price history...
            </div>
          )}
        </CornerBox>
      </div>
    </>
  )
}

function DeltaLine({
  label,
  value,
  pct,
}: {
  label: string
  value: number | null
  pct: number | null
}) {
  return (
    <div
      className="border px-2 py-1.5"
      style={{ borderColor: `${toneColor(value)}44`, color: toneColor(value) }}
    >
      <div className="tracking-[0.16em] opacity-70">{label}</div>
      <div className="mt-0.5 font-bold tabular-nums">
        {fmtSignedUSD(value)}
      </div>
      <div className="tabular-nums opacity-70">{fmtSignedPct(pct)}</div>
    </div>
  )
}

function LivePricePanel({
  label,
  price,
  previousClose,
  color,
}: {
  label: string
  price: number | null
  previousClose: number | null
  color: string
}) {
  const change =
    price != null && previousClose != null ? price - previousClose : null
  const pct =
    price != null && previousClose != null && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null
  return (
    <div className="border px-3 py-2" style={{ borderColor: `${color}33` }}>
      <div className="text-[10px] tracking-[0.18em]" style={{ color }}>
        {label}
      </div>
      <div className="mt-1 text-3xl font-bold leading-none">
        <LiveNumber value={price} format={fmtUSD} color={color} />
      </div>
      <div
        className="mt-2 text-[10px] tabular-nums"
        style={{ color: toneColor(change) }}
      >
        {fmtSignedUSD(change)} {fmtSignedPct(pct)} vs prev close
      </div>
    </div>
  )
}

function PositionCard({
  asset,
  color,
  quantity,
  quantityLabel,
  price,
  value,
  avgCost,
}: {
  asset: "CYPH" | "ZEC"
  color: string
  quantity: number
  quantityLabel: string
  price: number | null
  value: number | null
  avgCost: number | null
}) {
  const cost = avgCost != null ? quantity * avgCost : null
  const pnl = value != null && cost != null ? value - cost : null
  const pnlPct = value != null && cost != null && cost > 0 ? ((value - cost) / cost) * 100 : null
  return (
    <CornerBox label={`${asset} POSITION`} color={color}>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <div className="text-3xl font-bold leading-none">
            <LiveNumber value={value} format={fmtUSD} color={color} />
          </div>
          <div
            className="mt-1 text-[10px]"
            style={{ color: paletteVar("text"), opacity: 0.64 }}
          >
            {quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}{" "}
            {quantityLabel}
            {price != null ? ` @ ${fmtUSD(price)}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div
            className="text-[10px] tracking-[0.16em]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            AVG COST
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums" style={{ color }}>
            {avgCost != null ? fmtUSD(avgCost) : "--"}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <DeltaLine label="P/L" value={pnl} pct={pnlPct} />
        <div
          className="border px-2 py-1.5"
          style={{ borderColor: `${paletteVar("text")}22` }}
        >
          <div
            className="tracking-[0.16em]"
            style={{ color: paletteVar("text"), opacity: 0.62 }}
          >
            COST
          </div>
          <div
            className="mt-0.5 font-bold tabular-nums"
            style={{ color: paletteVar("text") }}
          >
            {cost != null ? fmtCompactUSD(cost) : "--"}
          </div>
          <div style={{ color: paletteVar("text"), opacity: 0.55 }}>
            {avgCost != null ? "tracked" : "add avg cost"}
          </div>
        </div>
      </div>
    </CornerBox>
  )
}

function WindowCell({
  row,
  active,
}: {
  row: { label: string; value: number | null; pct: number | null }
  active: boolean
}) {
  const color = toneColor(row.value)
  return (
    <div
      className="border px-2 py-1.5 text-center"
      style={{
        borderColor: active ? `${paletteVar("ratio")}88` : `${paletteVar("text")}22`,
        background: active ? `${paletteVar("ratio")}10` : "transparent",
      }}
    >
      <div
        className="text-[9px] tracking-[0.18em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {row.label}
      </div>
      <div className="mt-0.5 text-[12px] font-bold tabular-nums" style={{ color }}>
        {fmtSignedUSD(row.value)}
      </div>
      <div className="text-[10px] tabular-nums" style={{ color, opacity: 0.75 }}>
        {fmtSignedPct(row.pct)}
      </div>
    </div>
  )
}

function InputRow({
  label,
  value,
  onChange,
  color,
  suffix,
  nullable = false,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  color: string
  suffix: string
  nullable?: boolean
}) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className="text-[10px] tracking-[0.14em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {label}
      </span>
      <div className="flex items-center border" style={{ borderColor: `${color}55` }}>
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={asInputValue(value)}
          placeholder={nullable ? "--" : "0"}
          onChange={(event) => onChange(parseInputValue(event.target.value, nullable))}
          className="w-full flex-1 bg-transparent px-2 py-1.5 font-mono text-sm tabular-nums outline-none"
          style={{ color, caretColor: color }}
        />
        <span
          className="px-2 text-[9px] tracking-[0.12em]"
          style={{
            color,
            opacity: 0.75,
            borderLeft: `1px solid ${color}55`,
          }}
        >
          {suffix}
        </span>
      </div>
    </label>
  )
}
