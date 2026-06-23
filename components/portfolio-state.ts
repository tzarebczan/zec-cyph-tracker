"use client"

import { useEffect, useMemo, useState } from "react"
import type { PricesHistoryPoint } from "./api-types"

export const PORTFOLIO_HOLDINGS_KEY = "cyphzec.portfolio.v1"
export const PORTFOLIO_COST_BASIS_KEY = "cyphzec.portfolio.costBasis.v2"
const LEGACY_COST_BASIS_KEY = "cyphzec.beta.portfolio.costBasis"
const PORTFOLIO_EVENT = "cyphzec:portfolio"

export type PortfolioWindow = "1D" | "1W" | "1M" | "3M" | "6M"

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
  value: number
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
  windows: PortfolioWindowMetric[]
  history: PortfolioHistoryPoint[]
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

function portfolioValue(
  state: PortfolioState,
  cyphPrice: number | null | undefined,
  zecPrice: number | null | undefined
): number | null {
  const cyphPart =
    state.cyphShares > 0 && cyphPrice != null && Number.isFinite(cyphPrice)
      ? state.cyphShares * cyphPrice
      : state.cyphShares > 0
        ? null
        : 0
  const zecPart =
    state.zecCoins > 0 && zecPrice != null && Number.isFinite(zecPrice)
      ? state.zecCoins * zecPrice
      : state.zecCoins > 0
        ? null
        : 0
  return cyphPart == null || zecPart == null ? null : cyphPart + zecPart
}

function pointValue(state: PortfolioState, point: PricesHistoryPoint): number | null {
  return portfolioValue(state, point.cyph, point.zec)
}

function valueAtOrBefore(
  state: PortfolioState,
  history: PricesHistoryPoint[],
  daysBack: number
): number | null {
  const cutoff = Date.now() - daysBack * 86400_000
  const point = [...history]
    .reverse()
    .find((row) => row.timestamp <= cutoff && pointValue(state, row) != null)
  return point ? pointValue(state, point) : null
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
  const cyphValue =
    cyphPrice != null && state.cyphShares > 0 ? state.cyphShares * cyphPrice : state.cyphShares > 0 ? null : 0
  const zecValue =
    zecPrice != null && state.zecCoins > 0 ? state.zecCoins * zecPrice : state.zecCoins > 0 ? null : 0
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

  const cyphPreviousCloseValue =
    state.cyphShares > 0 && cyphPreviousClose != null
      ? state.cyphShares * cyphPreviousClose
      : state.cyphShares > 0
        ? null
        : 0
  const zecPreviousCloseValue =
    state.zecCoins > 0 && zecPreviousClose != null
      ? state.zecCoins * zecPreviousClose
      : state.zecCoins > 0
        ? null
        : 0
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

  const windows = (Object.keys(WINDOW_DAYS) as PortfolioWindow[]).map((key) => {
    const baseline =
      key === "1D"
        ? previousCloseValue
        : valueAtOrBefore(state, history, WINDOW_DAYS[key])
    return {
      key,
      label: key,
      value: totalValue != null && baseline != null ? totalValue - baseline : null,
      pct: pctChange(totalValue, baseline),
      baseline,
    }
  })

  const chartHistory = history
    .map((point): PortfolioHistoryPoint | null => {
      const value = pointValue(state, point)
      const cyph =
        state.cyphShares > 0 && point.cyph != null
          ? state.cyphShares * point.cyph
          : state.cyphShares > 0
            ? null
            : 0
      const zec =
        state.zecCoins > 0 && point.zec != null
          ? state.zecCoins * point.zec
          : state.zecCoins > 0
            ? null
          : 0
      return value == null
        ? null
        : {
            timestamp: point.timestamp,
            date: point.date,
            value,
            cyph,
            zec,
          }
    })
    .filter((row): row is PortfolioHistoryPoint => row != null)

  if (totalValue != null) {
    chartHistory.push({
      timestamp: Date.now(),
      date: new Date().toISOString().slice(0, 10),
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
