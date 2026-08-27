"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import {
  CornerBox,
  LiveNumber,
  Skeleton,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtUSD, fmtCompactUSD, swrFetcher } from "./format"
import {
  pickLiveCyphSession,
  shouldUseRegularSessionQuote,
} from "./quote-utils"
import {
  computePortfolioMetrics,
  hasPortfolioData,
  previousCloseFromHistory,
  scopeValue,
  usePortfolioState,
  PORTFOLIO_HISTORY_KEY,
  PORTFOLIO_SCOPES,
  type PortfolioHistoryPoint,
  type PortfolioScope,
  type PortfolioWindow,
} from "./portfolio-state"
import {
  sanitizeDashboardTiles,
  useCyphzecSettings,
} from "./use-cyphzec-settings"
import type { PricesHistoryPoint, PricesResponse, QuoteSnapshot } from "./api-types"

/** There used to be a fourth option, BOTH, which drew the two holdings as
 *  separate lines while TOTAL drew their sum — two buttons for the same
 *  portfolio, and neither changed the numbers in the cells. TOTAL now draws
 *  the sum *and* the components, so the selector answers exactly one
 *  question: whose performance am I reading? */
const SCOPE_LABEL: Record<PortfolioScope, string> = {
  total: "TOTAL",
  cyph: "CYPH",
  zec: "ZEC",
}
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

function previousFromPct(
  price: number | null | undefined,
  pct: number | null | undefined
): number | null {
  if (price == null || pct == null || !Number.isFinite(price) || !Number.isFinite(pct)) {
    return null
  }
  const divisor = 1 + pct / 100
  return divisor > 0 ? price / divisor : null
}

function cyphPortfolioPrice(
  quote: QuoteSnapshot | undefined,
  fallbackPrice: number | null,
  fallbackPreviousClose: number | null
) {
  const detail = pickLiveCyphSession(quote)
  if (!quote) {
    return {
      price: fallbackPrice,
      previousClose: fallbackPreviousClose,
      label: "CYPH",
      source: "loading quote",
    }
  }
  const regularSessionLive = shouldUseRegularSessionQuote(quote)
  if (detail.session === "REGULAR" && detail.price != null) {
    return {
      price: detail.price,
      previousClose: detail.prevClose ?? fallbackPreviousClose,
      label: regularSessionLive ? "CYPH LIVE" : "CYPH CLOSE",
      source: regularSessionLive ? "regular session" : "using previous close",
    }
  }
  return {
    price: quote.regularMarketPrice ?? detail.prevClose ?? fallbackPrice,
    previousClose: quote.regularMarketPreviousClose ?? fallbackPreviousClose,
    label: "CYPH CLOSE",
    source: "using previous close",
  }
}

function filterChartWindow(
  data: PortfolioHistoryPoint[],
  window: PortfolioWindow
) {
  const cutoff = Date.now() - WINDOW_DAYS[window] * 86400_000
  return data.filter((point) => point.timestamp >= cutoff)
}

function currentPortfolioPoint(metrics: ReturnType<typeof computePortfolioMetrics>): PortfolioHistoryPoint | null {
  if (metrics.totalValue == null) return null
  return {
    timestamp: Date.now(),
    // See the matching note in portfolio-state.ts: the chart prints this
    // string verbatim as its right-hand axis label.
    date: "NOW",
    value: metrics.totalValue,
    cyph: metrics.cyphValue,
    zec: metrics.zecValue,
  }
}

function oneDayChartData(metrics: ReturnType<typeof computePortfolioMetrics>): PortfolioHistoryPoint[] {
  const current = currentPortfolioPoint(metrics)
  if (!current || metrics.previousCloseValue == null) return []
  return [
    {
      timestamp: Date.now() - 86400_000,
      date: "PREV CLOSE",
      value: metrics.previousCloseValue,
      cyph: metrics.cyphPreviousCloseValue,
      zec: metrics.zecPreviousCloseValue,
    },
    current,
  ]
}

function portfolioScopeOptions(portfolio: {
  cyphShares: number
  zecCoins: number
}): PortfolioScope[] {
  const hasCyph = portfolio.cyphShares > 0
  const hasZec = portfolio.zecCoins > 0
  // A single-asset portfolio has nothing to total, so it gets one button.
  if (!hasCyph || !hasZec) return hasCyph ? ["cyph"] : hasZec ? ["zec"] : []
  return [...PORTFOLIO_SCOPES]
}

function chartValue(
  point: PortfolioHistoryPoint,
  key: "value" | "cyph" | "zec"
): number | null {
  const value = point[key]
  return value != null && Number.isFinite(value) ? value : null
}

export function Portfolio() {
  const [portfolio, setPortfolio, saved, hydrated] = usePortfolioState()
  const [settings, setSetting] = useCyphzecSettings()
  const [window, setWindow] = useState<PortfolioWindow>("1M")
  const [scope, setScope] = useState<PortfolioScope>("total")

  const { data: prices } = useSWR<PricesResponse>(
    PORTFOLIO_HISTORY_KEY,
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
  const cyphHistoryPreviousClose = previousCloseFromHistory(history, "cyph")
  const cyphFallbackPrice = prices?.current?.cyph?.price ?? null
  const cyphFallbackPreviousClose =
    cyphHistoryPreviousClose ??
    previousFromPct(cyphFallbackPrice, prices?.current?.cyph?.change24h)
  const cyphSnapshot = cyphPortfolioPrice(
    quote,
    cyphFallbackPrice,
    cyphFallbackPreviousClose
  )
  const cyphPrice = cyphSnapshot.price
  const zecPrice = prices?.current?.zec?.price ?? null
  const cyphPreviousClose = cyphSnapshot.previousClose
  const zecPreviousClose =
    previousCloseFromHistory(history, "zec") ??
    previousFromPct(zecPrice, prices?.current?.zec?.change24h)

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
  const scopeOptions = useMemo(
    () => portfolioScopeOptions(portfolio),
    [portfolio]
  )
  useEffect(() => {
    if (scopeOptions.length > 0 && !scopeOptions.includes(scope)) {
      setScope(scopeOptions[0])
    }
  }, [scope, scopeOptions])
  const dashboardTiles = sanitizeDashboardTiles(settings.dashboardTiles)
  const portfolioTileEnabled = dashboardTiles.includes("portfolio")
  const enablePortfolioTile = () => {
    if (portfolioTileEnabled) return
    setSetting("dashboardTiles", [...dashboardTiles, "portfolio"])
  }
  const scopeWindows = metrics.windows[scope]
  const activeWindow = scopeWindows.find((row) => row.key === window)
  const scopeLive = scopeValue(metrics, scope)
  const chartData =
    window === "1D"
      ? oneDayChartData(metrics)
      : filterChartWindow(metrics.history, window)
  const loadedMetrics = hydrated ? metrics : null

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-base font-bold tracking-[0.2em]">PORTFOLIO</h1>
        <span
          className="text-[11px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          private - on-device only
        </span>
        {hydrated && hasData && !portfolioTileEnabled && (
          <button
            type="button"
            onClick={enablePortfolioTile}
            className="px-2 py-0.5 text-[11px] font-bold tracking-[0.16em] transition-colors"
            style={{
              color: paletteVar("ratio"),
              border: `1px solid ${paletteVar("ratio")}55`,
              background: `${paletteVar("ratio")}0d`,
            }}
          >
            SHOW ON DASHBOARD
          </button>
        )}
        {hydrated && hasData && portfolioTileEnabled && (
          <span
            className="px-2 py-0.5 text-[11px] tracking-[0.14em]"
            style={{
              color: paletteVar("ratio"),
              border: `1px solid ${paletteVar("ratio")}33`,
              opacity: 0.72,
            }}
          >
            DASHBOARD TILE ON
          </span>
        )}
        <span
          className="ml-auto hidden items-center gap-1.5 px-2 py-0.5 text-[11px] transition-opacity sm:inline-flex"
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
        <div className="grid items-start gap-3 lg:grid-cols-[1.15fr_0.75fr_0.75fr_0.85fr]">
          <div>
            <div
              className="text-[11px] tracking-[0.18em]"
              style={{ color: paletteVar("text"), opacity: 0.62 }}
            >
              NET VALUE - MARKED
            </div>
            <div className="mt-1 text-4xl font-bold leading-none md:text-5xl">
              {loadedMetrics ? (
                <LiveNumber
                  value={loadedMetrics.totalValue}
                  format={fmtUSD}
                  color={paletteVar("ratio")}
                />
              ) : (
                <Skeleton height={46} />
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] md:max-w-xl">
              <DeltaLine label="DAILY TOTAL" value={loadedMetrics?.dailyChange ?? null} pct={loadedMetrics?.dailyChangePct ?? null} />
              <DeltaLine label="CYPH DAY" value={loadedMetrics?.cyphDailyChange ?? null} pct={loadedMetrics?.cyphDailyChangePct ?? null} />
              <DeltaLine label="ZEC DAY" value={loadedMetrics?.zecDailyChange ?? null} pct={loadedMetrics?.zecDailyChangePct ?? null} />
              <DeltaLine label="VS AVG COST" value={loadedMetrics?.totalPnl ?? null} pct={loadedMetrics?.totalPnlPct ?? null} />
            </div>
          </div>

          <LivePricePanel
            label={cyphSnapshot.label}
            price={cyphPrice}
            previousClose={cyphPreviousClose}
            source={cyphSnapshot.source}
            color={paletteVar("cyph")}
          />
          <LivePricePanel
            label="ZEC LIVE"
            price={zecPrice}
            previousClose={zecPreviousClose}
            source="24H crypto market"
            color={paletteVar("zec")}
          />
          <div
            className="border px-3 py-2"
            style={{ borderColor: `${paletteVar("text")}22` }}
          >
            <div
              className="text-[11px] tracking-[0.18em]"
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
              {!hydrated
                ? "LOADING"
                : metrics.totalCost != null
                  ? fmtUSD(metrics.totalCost)
                  : "SET AVG COSTS"}
            </div>
            <div
              className="mt-1 text-[11px] leading-relaxed"
              style={{ color: paletteVar("text"), opacity: 0.58 }}
            >
              Total change compares live value against CYPH avg/share and ZEC avg/ZEC.
            </div>
          </div>
        </div>
      </CornerBox>

      {!hydrated ? (
        <section className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <LoadingPositionCard label="CYPH POSITION" color={paletteVar("cyph")} />
          <LoadingPositionCard label="ZEC POSITION" color={paletteVar("zec")} />
        </section>
      ) : hasData ? (
        <section className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {portfolio.cyphShares > 0 && (
            <PositionCard
              asset="CYPH"
              color={paletteVar("cyph")}
              quantity={portfolio.cyphShares}
              quantityLabel="shares"
              price={cyphPrice}
              value={metrics.cyphValue}
              avgCost={portfolio.cyphAvgCost}
              dailyValue={metrics.cyphDailyChange}
              dailyPct={metrics.cyphDailyChangePct}
              priceNote={cyphSnapshot.source}
            />
          )}
          {portfolio.zecCoins > 0 && (
            <PositionCard
              asset="ZEC"
              color={paletteVar("zec")}
              quantity={portfolio.zecCoins}
              quantityLabel="ZEC"
              price={zecPrice}
              value={metrics.zecValue}
              avgCost={portfolio.zecAvgCost}
              dailyValue={metrics.zecDailyChange}
              dailyPct={metrics.zecDailyChangePct}
              priceNote="24H crypto market"
            />
          )}
        </section>
      ) : null}

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
            className="mt-3 text-[11px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.52 }}
          >
            Stored only in this browser. Cost basis is average entry price per asset,
            not total dollars invested.
          </p>
        </CornerBox>

        <CornerBox
          label={`PERFORMANCE - ${SCOPE_LABEL[scope]}`}
          action={
            <div
              className="flex flex-wrap justify-end gap-1"
              role="group"
              aria-label="Performance scope"
            >
              {scopeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={scope === option}
                  onClick={() => setScope(option)}
                  className="px-2 py-0.5 text-[11px] font-bold tracking-[0.12em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                  style={{
                    color: scope === option ? "#000" : paletteVar("text"),
                    background: scope === option ? paletteVar("ratio") : "transparent",
                    border: `1px solid ${scope === option ? paletteVar("ratio") : `${paletteVar("text")}33`}`,
                    outlineColor: paletteVar("ratio"),
                  }}
                >
                  {SCOPE_LABEL[option]}
                </button>
              ))}
            </div>
          }
        >
          {!hydrated ? (
            <div
              className="flex min-h-[260px] items-center justify-center text-[11px]"
              style={{ color: paletteVar("text"), opacity: 0.58 }}
            >
              Loading saved portfolio...
            </div>
          ) : !hasData ? (
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
          ) : (
            <>
              {/* The cells are the window selector. They used to only mark
                  which window a separate chip row had chosen, which meant two
                  controls for one setting - and they render outside the chart
                  guard so the window is still switchable while a window has
                  no history to draw. */}
              <div
                className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-5"
                role="group"
                aria-label="Performance window"
              >
                {scopeWindows.map((row) => (
                  <WindowCell
                    key={row.key}
                    row={row}
                    active={row.key === window}
                    onSelect={() => setWindow(row.key)}
                  />
                ))}
              </div>
              {chartData.length >= 2 ? (
                <>
                  <PortfolioPerformanceChart
                    data={chartData}
                    scope={scope}
                    height={260}
                    hasCyph={portfolio.cyphShares > 0}
                    hasZec={portfolio.zecCoins > 0}
                  />
                  <div
                    className="mt-2 text-[11px]"
                    style={{ color: paletteVar("text"), opacity: 0.62 }}
                  >
                    {activeWindow?.baseline != null && scopeLive != null ? (
                      <>
                        {SCOPE_LABEL[scope]} over {window}:{" "}
                        <span className="tabular-nums">
                          {fmtUSD(activeWindow.baseline)}
                        </span>{" "}
                        &rarr;{" "}
                        <span className="tabular-nums">{fmtUSD(scopeLive)}</span>
                        {window === "1D"
                          ? " - measured from the previous close"
                          : ` - measured from the last close at least ${WINDOW_DAYS[window]} days back`}
                      </>
                    ) : (
                      `No ${window} baseline yet - ${SCOPE_LABEL[scope]} price history does not reach back that far.`
                    )}
                  </div>
                </>
              ) : (
                <div
                  className="flex min-h-[260px] items-center justify-center text-center text-[11px]"
                  style={{ color: paletteVar("text"), opacity: 0.58 }}
                >
                  No {SCOPE_LABEL[scope]} history to chart over {window}.
                </div>
              )}
            </>
          )}
        </CornerBox>
      </div>
    </>
  )
}

function PortfolioPerformanceChart({
  data,
  scope,
  hasCyph,
  hasZec,
  height,
}: {
  data: PortfolioHistoryPoint[]
  scope: PortfolioScope
  hasCyph: boolean
  hasZec: boolean
  height: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 900
  const padding = { l: 64, r: 20, t: 16, b: 22 }
  const innerW = width - padding.l - padding.r
  const innerH = height - padding.t - padding.b
  const text = paletteVar("text")
  const series = useMemo(() => {
    const specs: {
      key: "value" | "cyph" | "zec"
      label: string
      color: string
      dash?: string
    }[] = []
    if (scope === "cyph") {
      specs.push({ key: "cyph", label: "CYPH", color: paletteVar("cyph") })
    } else if (scope === "zec") {
      specs.push({ key: "zec", label: "ZEC", color: paletteVar("zec") })
    } else {
      // TOTAL draws the sum plus its parts, so the reader can see which
      // holding moved the line without changing what the cells describe.
      specs.push({ key: "value", label: "TOTAL", color: paletteVar("ratio") })
      if (hasCyph) {
        specs.push({
          key: "cyph",
          label: "CYPH",
          color: paletteVar("cyph"),
          dash: "4 2",
        })
      }
      if (hasZec) {
        specs.push({
          key: "zec",
          label: "ZEC",
          color: paletteVar("zec"),
          dash: "4 2",
        })
      }
    }
    return specs
      .map((spec) => ({
        ...spec,
        points: data
          .map((point) => {
            const value = chartValue(point, spec.key)
            return value == null
              ? null
              : {
                  timestamp: point.timestamp,
                  date: point.date,
                  value,
                }
          })
          .filter((point): point is { timestamp: number; date: string; value: number } => point != null),
      }))
      .filter((item) => item.points.length >= 2)
  }, [data, hasCyph, hasZec, scope])

  const allPoints = series.flatMap((item) => item.points)
  if (series.length === 0 || allPoints.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: text, opacity: 0.58 }}
      >
        Need more price history for this view.
      </div>
    )
  }

  const minTs = Math.min(...allPoints.map((point) => point.timestamp))
  const maxTs = Math.max(...allPoints.map((point) => point.timestamp))
  const values = allPoints.map((point) => point.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const valueSpan = maxValue - minValue || Math.max(Math.abs(maxValue), 1)
  const paddedMin = minValue - valueSpan * 0.06
  const paddedMax = maxValue + valueSpan * 0.08
  const scaleX = (timestamp: number) =>
    padding.l + ((timestamp - minTs) / (maxTs - minTs || 1)) * innerW
  const scaleY = (value: number) =>
    padding.t + (1 - (value - paddedMin) / (paddedMax - paddedMin || 1)) * innerH
  const pathFor = (points: { timestamp: number; value: number }[]) =>
    points
      .map((point, index) =>
        `${index === 0 ? "M" : "L"}${scaleX(point.timestamp)},${scaleY(point.value)}`
      )
      .join(" ")
  const active =
    hover == null
      ? null
      : allPoints.reduce((best, point) =>
          Math.abs(point.timestamp - hover) < Math.abs(best.timestamp - hover)
            ? point
            : best
        )

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * width
    const pct = Math.min(1, Math.max(0, (x - padding.l) / innerW))
    setHover(minTs + pct * (maxTs - minTs))
  }

  const labelFor = (timestamp: number) => {
    const point = allPoints.reduce((best, item) =>
      Math.abs(item.timestamp - timestamp) < Math.abs(best.timestamp - timestamp)
        ? item
        : best
    )
    return point.date
  }

  return (
    <svg
      role="img"
      aria-label="Portfolio performance history"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ display: "block", overflow: "visible" }}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const y = padding.t + tick * innerH
        const value = paddedMax - tick * (paddedMax - paddedMin)
        return (
          <g key={tick}>
            <line
              x1={padding.l}
              y1={y}
              x2={width - padding.r}
              y2={y}
              stroke={text}
              strokeOpacity={0.12}
              strokeDasharray="1 4"
            />
            <text
              x={padding.l - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="10"
              fill={text}
              fillOpacity={0.58}
              fontFamily="ui-monospace, monospace"
            >
              {fmtCompactUSD(value)}
            </text>
          </g>
        )
      })}
      {series.map((item) => {
        const path = pathFor(item.points)
        return (
          <path
            key={item.key}
            d={path}
            fill="none"
            stroke={item.color}
            strokeWidth={1.8}
            strokeDasharray={item.dash}
            style={{ filter: `drop-shadow(0 0 4px ${item.color}40)` }}
          />
        )
      })}
      {active && (
        <>
          <line
            x1={scaleX(active.timestamp)}
            y1={padding.t}
            x2={scaleX(active.timestamp)}
            y2={padding.t + innerH}
            stroke={paletteVar("ratio")}
            strokeOpacity={0.45}
            strokeDasharray="2 3"
          />
          <g transform={`translate(${Math.min(scaleX(active.timestamp) + 10, width - 190)}, ${padding.t + 10})`}>
            <rect
              width="178"
              height={20 + series.length * 16}
              fill="#020504"
              stroke={paletteVar("ratio")}
              strokeOpacity={0.7}
            />
            <text
              x="8"
              y="14"
              fontSize="10"
              fill={text}
              fillOpacity={0.72}
              fontFamily="ui-monospace, monospace"
            >
              {labelFor(active.timestamp)}
            </text>
            {series.map((item, index) => {
              const point = item.points.reduce((best, candidate) =>
                Math.abs(candidate.timestamp - active.timestamp) <
                Math.abs(best.timestamp - active.timestamp)
                  ? candidate
                  : best
              )
              return (
                <text
                  key={item.key}
                  x="8"
                  y={31 + index * 16}
                  fontSize="11"
                  fill={item.color}
                  fontFamily="ui-monospace, monospace"
                  fontWeight="bold"
                >
                  {item.label} {fmtUSD(point.value)}
                </text>
              )
            })}
          </g>
        </>
      )}
      <text
        x={padding.l}
        y={height - 4}
        fontSize="10"
        fill={text}
        fillOpacity={0.5}
        fontFamily="ui-monospace, monospace"
      >
        {labelFor(minTs)}
      </text>
      <text
        x={width - padding.r}
        y={height - 4}
        textAnchor="end"
        fontSize="10"
        fill={text}
        fillOpacity={0.5}
        fontFamily="ui-monospace, monospace"
      >
        {labelFor(maxTs)}
      </text>
    </svg>
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
  source,
  color,
}: {
  label: string
  price: number | null
  previousClose: number | null
  source: string
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
      <div className="text-[11px] tracking-[0.18em]" style={{ color }}>
        {label}
      </div>
      <div className="mt-1 text-3xl font-bold leading-none">
        <LiveNumber value={price} format={fmtUSD} color={color} />
      </div>
      <div
        className="mt-2 text-[11px] tabular-nums"
        style={{ color: toneColor(change) }}
      >
        {fmtSignedUSD(change)} {fmtSignedPct(pct)} vs prev close
      </div>
      <div
        className="mt-1 text-[10px] tracking-[0.12em]"
        style={{ color: paletteVar("text"), opacity: 0.52 }}
      >
        {source}
      </div>
    </div>
  )
}

function LoadingPositionCard({
  label,
  color,
}: {
  label: string
  color: string
}) {
  return (
    <CornerBox label={label} color={color}>
      <div className="space-y-3">
        <Skeleton height={34} />
        <Skeleton height={18} />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
        <Skeleton height={44} />
      </div>
    </CornerBox>
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
  dailyValue,
  dailyPct,
  priceNote,
}: {
  asset: "CYPH" | "ZEC"
  color: string
  quantity: number
  quantityLabel: string
  price: number | null
  value: number | null
  avgCost: number | null
  dailyValue: number | null
  dailyPct: number | null
  priceNote: string
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
            className="mt-1 text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.64 }}
          >
            {quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}{" "}
            {quantityLabel}
            {price != null ? ` @ ${fmtUSD(price)}` : ""}
            {price != null ? ` - ${priceNote}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div
            className="text-[11px] tracking-[0.16em]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            AVG COST
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums" style={{ color }}>
            {avgCost != null ? fmtUSD(avgCost) : "--"}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <DeltaLine label="DAY" value={dailyValue} pct={dailyPct} />
        <DeltaLine label="P/L" value={pnl} pct={pnlPct} />
      </div>
      <div
        className="mt-2 text-[11px] tabular-nums"
        style={{ color: paletteVar("text"), opacity: 0.56 }}
      >
        Cost basis {cost != null ? fmtCompactUSD(cost) : "--"} -{" "}
        {avgCost != null ? "tracked" : "add avg cost"}
      </div>
    </CornerBox>
  )
}

function WindowCell({
  row,
  active,
  onSelect,
}: {
  row: { label: string; value: number | null; pct: number | null }
  active: boolean
  onSelect: () => void
}) {
  const color = toneColor(row.value)
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className="border px-2 py-1.5 text-center transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{
        borderColor: active ? `${paletteVar("ratio")}88` : `${paletteVar("text")}22`,
        background: active ? `${paletteVar("ratio")}10` : "transparent",
        outlineColor: paletteVar("ratio"),
      }}
    >
      <div
        className="text-[10px] tracking-[0.18em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {row.label}
      </div>
      <div className="mt-0.5 text-[12px] font-bold tabular-nums" style={{ color }}>
        {fmtSignedUSD(row.value)}
      </div>
      <div className="text-[11px] tabular-nums" style={{ color, opacity: 0.75 }}>
        {fmtSignedPct(row.pct)}
      </div>
    </button>
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
        className="text-[11px] tracking-[0.14em]"
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
          className="px-2 text-[10px] tracking-[0.12em]"
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
