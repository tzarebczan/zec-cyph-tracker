"use client"

import { useEffect, useMemo, useState } from "react"
import type { PricesHistoryPoint } from "./api-types"

export const PORTFOLIO_HOLDINGS_KEY = "cyphzec.portfolio.v1"
export const PORTFOLIO_COST_BASIS_KEY = "cyphzec.portfolio.costBasis.v2"
const LEGACY_COST_BASIS_KEY = "cyphzec.beta.portfolio.costBasis"
const PORTFOLIO_EVENT = "cyphzec:portfolio"

export type PortfolioWindow = "1D" | "1W" | "1M" | "3M" | "6M"

/** What a performance reading covers. Every number the performance panel
 *  shows is scoped, so a reading can never silently describe a different
 *  holding than the one selected. */
export type PortfolioScope = "total" | "cyph" | "zec"
export const PORTFOLIO_SCOPES: readonly PortfolioScope[] = [
  "total",
  "cyph",
  "zec",
]

export interface PortfolioState {
  cyphShares: number
  zecCoins: number
  cyphAvgCost: number | null
  zecAvgCost: number | null
}

export interface PortfolioWindowMetric {
  key: PortfolioWindow
  label: string
  value: number | null
  pct: number | null
  baseline: number | null
}

export interface PortfolioHistoryPoint {
  timestamp: number
  date: string
  /** Null on a day the portfolio as a whole cannot be valued - a mixed
   *  portfolio at a weekend, where CYPH has no candle. The row is still kept
   *  because the single-asset scopes can plot it; each series drops its own
   *  null points when it builds its path. */
  value: number | null
  cyph: number | null
  zec: number | null
}

export interface PortfolioMetrics {
  cyphValue: number | null
  zecValue: number | null
  totalValue: number | null
  totalCost: number | null
  costBasisComplete: boolean
  totalPnl: number | null
  totalPnlPct: number | null
  cyphPreviousCloseValue: number | null
  zecPreviousCloseValue: number | null
  previousCloseValue: number | null
  cyphDailyChange: number | null
  cyphDailyChangePct: number | null
  zecDailyChange: number | null
  zecDailyChangePct: number | null
  dailyChange: number | null
  dailyChangePct: number | null
  /** One set of windows per scope. The CYPH and ZEC sets are measured against
   *  that asset's own baseline, so switching scope moves the cells and not
   *  just the chart. */
  windows: Record<PortfolioScope, PortfolioWindowMetric[]>
  history: PortfolioHistoryPoint[]
}

/** The live value a scope's deltas are measured from. */
export function scopeValue(
  metrics: PortfolioMetrics,
  scope: PortfolioScope
): number | null {
  if (scope === "cyph") return metrics.cyphValue
  if (scope === "zec") return metrics.zecValue
  return metrics.totalValue
}

export const EMPTY_PORTFOLIO: PortfolioState = {
  cyphShares: 0,
  zecCoins: 0,
  cyphAvgCost: null,
  zecAvgCost: null,
}

const WINDOW_DAYS: Record<PortfolioWindow, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
}

function cleanNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : fallback
}

function cleanCost(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null
}

function parseMaybeNumber(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function samePortfolioState(a: PortfolioState, b: PortfolioState): boolean {
  return (
    a.cyphShares === b.cyphShares &&
    a.zecCoins === b.zecCoins &&
    a.cyphAvgCost === b.cyphAvgCost &&
    a.zecAvgCost === b.zecAvgCost
  )
}

function loadHoldings(): Pick<PortfolioState, "cyphShares" | "zecCoins"> {
  if (typeof window === "undefined") return EMPTY_PORTFOLIO
  try {
    const raw = window.localStorage.getItem(PORTFOLIO_HOLDINGS_KEY)
    if (!raw) return EMPTY_PORTFOLIO
    const parsed = JSON.parse(raw) as Partial<PortfolioState>
    return {
      cyphShares: cleanNumber(parsed.cyphShares),
      zecCoins: cleanNumber(parsed.zecCoins),
    }
  } catch {
    return EMPTY_PORTFOLIO
  }
}

function loadCostBasis(
  holdings: Pick<PortfolioState, "cyphShares" | "zecCoins">
): Pick<PortfolioState, "cyphAvgCost" | "zecAvgCost"> {
  if (typeof window === "undefined") return EMPTY_PORTFOLIO
  try {
    const raw = window.localStorage.getItem(PORTFOLIO_COST_BASIS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PortfolioState>
      return {
        cyphAvgCost: cleanCost(parsed.cyphAvgCost),
        zecAvgCost: cleanCost(parsed.zecAvgCost),
      }
    }

    const legacy = parseMaybeNumber(
      window.localStorage.getItem(LEGACY_COST_BASIS_KEY)
    )
    if (legacy == null) return EMPTY_PORTFOLIO

    if (holdings.zecCoins > 0 && holdings.cyphShares <= 0) {
      return { cyphAvgCost: null, zecAvgCost: legacy }
    }
    if (holdings.cyphShares > 0 && holdings.zecCoins <= 0) {
      return { cyphAvgCost: legacy, zecAvgCost: null }
    }
    return EMPTY_PORTFOLIO
  } catch {
    return EMPTY_PORTFOLIO
  }
}

export function loadPortfolioState(): PortfolioState {
  const holdings = loadHoldings()
  const costs = loadCostBasis(holdings)
  return { ...EMPTY_PORTFOLIO, ...holdings, ...costs }
}

export function savePortfolioState(state: PortfolioState) {
  if (typeof window === "undefined") return
  const clean: PortfolioState = {
    cyphShares: cleanNumber(state.cyphShares),
    zecCoins: cleanNumber(state.zecCoins),
    cyphAvgCost: cleanCost(state.cyphAvgCost),
    zecAvgCost: cleanCost(state.zecAvgCost),
  }
  try {
    window.localStorage.setItem(
      PORTFOLIO_HOLDINGS_KEY,
      JSON.stringify({
        cyphShares: clean.cyphShares > 0 ? clean.cyphShares : null,
        zecCoins: clean.zecCoins > 0 ? clean.zecCoins : null,
      })
    )
    window.localStorage.setItem(
      PORTFOLIO_COST_BASIS_KEY,
      JSON.stringify({
        cyphAvgCost: clean.cyphAvgCost,
        zecAvgCost: clean.zecAvgCost,
      })
    )
    window.dispatchEvent(new CustomEvent(PORTFOLIO_EVENT, { detail: clean }))
  } catch {
    /* localStorage can fail in private mode; portfolio stays in memory. */
  }
}

/** History window both portfolio surfaces read. 270 days - the route's
 *  maximum - because a window baseline is the newest candle at least N days
 *  old, and a history that starts exactly N days ago has no such candle. At
 *  180 the 6M cell read "--" permanently; at 90 the dashboard tile's 90D cell
 *  did. Shared so the two surfaces hit one cache entry. */
export const PORTFOLIO_HISTORY_KEY = "/api/prices?days=270"

/** The last daily close before today. Compares UTC day keys derived from each
 *  point's timestamp, NOT the payload's `date` field: that field is a display
 *  string ("Aug 26"), so `row.date < "2026-08-27"` was false for every row and
 *  this always returned null. The daily change happened to survive on a
 *  `change24h` fallback that the route derives from this same history - but any
 *  gap in that field silently blanked the day's numbers while the close sat
 *  right here in the payload. */
export function previousCloseFromHistory(
  history: PricesHistoryPoint[],
  key: "cyph" | "zec"
): number | null {
  const today = new Date().toISOString().slice(0, 10)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index]
    const value = row[key]
    if (value == null || !Number.isFinite(value)) continue
    if (new Date(row.timestamp).toISOString().slice(0, 10) < today) return value
  }
  return null
}

export function hasPortfolioData(state: PortfolioState): boolean {
  return state.cyphShares > 0 || state.zecCoins > 0
}

export function usePortfolioState(): [
  PortfolioState,
  <K extends keyof PortfolioState>(key: K, value: PortfolioState[K]) => void,
  boolean,
  boolean,
] {
  const [state, setState] = useState<PortfolioState>(EMPTY_PORTFOLIO)
  const [hydrated, setHydrated] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setState(loadPortfolioState())
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    savePortfolioState(state)
    setSaved(true)
    const t = setTimeout(() => setSaved(false), 1100)
    return () => clearTimeout(t)
  }, [state, hydrated])

  useEffect(() => {
    const refresh = () => setState(loadPortfolioState())
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === PORTFOLIO_HOLDINGS_KEY ||
        event.key === PORTFOLIO_COST_BASIS_KEY ||
        event.key === LEGACY_COST_BASIS_KEY
      ) {
        refresh()
      }
    }
    const onPortfolio = (event: Event) => {
      const detail = (event as CustomEvent<PortfolioState>).detail
      if (!detail) return
      setState((prev) => (samePortfolioState(prev, detail) ? prev : detail))
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(PORTFOLIO_EVENT, onPortfolio)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(PORTFOLIO_EVENT, onPortfolio)
    }
  }, [])

  const setField = <K extends keyof PortfolioState>(
    key: K,
    value: PortfolioState[K]
  ) => {
    setState((prev) => ({ ...prev, [key]: value }))
  }

  return [state, setField, saved, hydrated]
}

/** A holding's worth at a price. Zero quantity is worth zero (not unknown);
 *  a held quantity with no price is unknown, which is what keeps a missing
 *  candle out of a baseline instead of counting it as $0. */
function holdingValue(
  quantity: number,
  price: number | null | undefined
): number | null {
  if (quantity <= 0) return 0
  return price != null && Number.isFinite(price) ? quantity * price : null
}

function portfolioValue(
  state: PortfolioState,
  cyphPrice: number | null | undefined,
  zecPrice: number | null | undefined
): number | null {
  const cyphPart = holdingValue(state.cyphShares, cyphPrice)
  const zecPart = holdingValue(state.zecCoins, zecPrice)
  return cyphPart == null || zecPart == null ? null : cyphPart + zecPart
}

function pointValue(state: PortfolioState, point: PricesHistoryPoint): number | null {
  return portfolioValue(state, point.cyph, point.zec)
}

/** Value of the scope's holding at the newest candle that is at least
 *  `daysBack` old. Candles the scope has no price for are skipped, which
 *  matters because CYPH does not trade on weekends: a 30-day lookback that
 *  lands on a Saturday walks back to Friday rather than reporting nothing. */
function baselineAt(
  history: PricesHistoryPoint[],
  daysBack: number,
  valueAt: (point: PricesHistoryPoint) => number | null
): number | null {
  const cutoff = Date.now() - daysBack * 86400_000
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index]
    if (row.timestamp > cutoff) continue
    const value = valueAt(row)
    if (value != null) return value
  }
  return null
}

function buildWindows(
  live: number | null,
  previousCloseValue: number | null,
  history: PricesHistoryPoint[],
  valueAt: (point: PricesHistoryPoint) => number | null
): PortfolioWindowMetric[] {
  return (Object.keys(WINDOW_DAYS) as PortfolioWindow[]).map((key) => {
    // 1D is the only window measured off a session close rather than a
    // calendar lookback, so it agrees with the live tile above it.
    const baseline =
      key === "1D" ? previousCloseValue : baselineAt(history, WINDOW_DAYS[key], valueAt)
    return {
      key,
      label: key,
      value: live != null && baseline != null ? live - baseline : null,
      pct: pctChange(live, baseline),
      baseline,
    }
  })
}

function pctChange(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || baseline <= 0) return null
  return ((value - baseline) / baseline) * 100
}

export function computePortfolioMetrics({
  state,
  cyphPrice,
  zecPrice,
  cyphPreviousClose,
  zecPreviousClose,
  history,
}: {
  state: PortfolioState
  cyphPrice: number | null
  zecPrice: number | null
  cyphPreviousClose: number | null
  zecPreviousClose: number | null
  history: PricesHistoryPoint[]
}): PortfolioMetrics {
  const cyphValue = holdingValue(state.cyphShares, cyphPrice)
  const zecValue = holdingValue(state.zecCoins, zecPrice)
  const totalValue =
    cyphValue != null && zecValue != null ? cyphValue + zecValue : null

  const cyphCost =
    state.cyphShares > 0 && state.cyphAvgCost != null
      ? state.cyphShares * state.cyphAvgCost
      : state.cyphShares > 0
        ? null
        : 0
  const zecCost =
    state.zecCoins > 0 && state.zecAvgCost != null
      ? state.zecCoins * state.zecAvgCost
      : state.zecCoins > 0
        ? null
        : 0
  const costBasisComplete = cyphCost != null && zecCost != null
  const totalCost = costBasisComplete ? cyphCost + zecCost : null
  const totalPnl =
    totalValue != null && totalCost != null ? totalValue - totalCost : null

  const cyphPreviousCloseValue = holdingValue(state.cyphShares, cyphPreviousClose)
  const zecPreviousCloseValue = holdingValue(state.zecCoins, zecPreviousClose)
  const previousCloseValue =
    cyphPreviousCloseValue != null && zecPreviousCloseValue != null
      ? cyphPreviousCloseValue + zecPreviousCloseValue
      : null
  const cyphDailyChange =
    cyphValue != null && cyphPreviousCloseValue != null
      ? cyphValue - cyphPreviousCloseValue
      : null
  const zecDailyChange =
    zecValue != null && zecPreviousCloseValue != null
      ? zecValue - zecPreviousCloseValue
      : null
  const dailyChange =
    totalValue != null && previousCloseValue != null
      ? totalValue - previousCloseValue
      : null

  const windows: Record<PortfolioScope, PortfolioWindowMetric[]> = {
    total: buildWindows(totalValue, previousCloseValue, history, (point) =>
      portfolioValue(state, point.cyph, point.zec)
    ),
    cyph: buildWindows(cyphValue, cyphPreviousCloseValue, history, (point) =>
      holdingValue(state.cyphShares, point.cyph)
    ),
    zec: buildWindows(zecValue, zecPreviousCloseValue, history, (point) =>
      holdingValue(state.zecCoins, point.zec)
    ),
  }

  const chartHistory = history
    .map((point): PortfolioHistoryPoint | null => {
      const value = pointValue(state, point)
      const cyph = holdingValue(state.cyphShares, point.cyph)
      const zec = holdingValue(state.zecCoins, point.zec)
      // Keep a row any one scope can plot. Requiring a whole-portfolio value
      // dropped every weekend from a mixed portfolio, because CYPH has no
      // candle then - which left the ZEC chart weekday-only while the ZEC
      // window cells were measuring against the very candles it had discarded.
      if (value == null && cyph == null && zec == null) return null
      return { timestamp: point.timestamp, date: point.date, value, cyph, zec }
    })
    .filter((row): row is PortfolioHistoryPoint => row != null)

  if (totalValue != null || cyphValue != null || zecValue != null) {
    chartHistory.push({
      timestamp: Date.now(),
      // "NOW", not an ISO date: every other point carries the route's
      // display format ("Jul 29, 26"), and the chart prints this string
      // verbatim as its right-hand axis label.
      date: "NOW",
      value: totalValue,
      cyph: cyphValue,
      zec: zecValue,
    })
  }

  return {
    cyphValue,
    zecValue,
    totalValue,
    totalCost,
    costBasisComplete,
    totalPnl,
    totalPnlPct: pctChange(totalValue, totalCost),
    cyphPreviousCloseValue,
    zecPreviousCloseValue,
    previousCloseValue,
    cyphDailyChange,
    cyphDailyChangePct: pctChange(cyphValue, cyphPreviousCloseValue),
    zecDailyChange,
    zecDailyChangePct: pctChange(zecValue, zecPreviousCloseValue),
    dailyChange,
    dailyChangePct: pctChange(totalValue, previousCloseValue),
    windows,
    history: chartHistory,
  }
}

export function usePortfolioMetrics(input: Parameters<typeof computePortfolioMetrics>[0]) {
  return useMemo(() => computePortfolioMetrics(input), [
    input.state,
    input.cyphPrice,
    input.zecPrice,
    input.cyphPreviousClose,
    input.zecPreviousClose,
    input.history,
  ])
}
