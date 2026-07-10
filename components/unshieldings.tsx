"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import useSWR from "swr"
import { usePersistentState } from "@/lib/use-persistent-state"
import { CornerBox, Skeleton, useIsMobile } from "./primitives"
import { fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import type {
  PostUnshieldStatus,
  PostUnshieldSummary,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "./api-types"

type PoolMode = "orchard" | "all"

function isValidPoolMode(v: unknown): v is PoolMode {
  return v === "orchard" || v === "all"
}

function isValidUnshieldingPeriod(v: unknown): v is UnshieldingPeriod {
  return v === "1h" || v === "12h" || v === "1d" || v === "1w" || v === "1m" || v === "all"
}

function isValidUnshieldingSort(v: unknown): v is UnshieldingSort {
  return v === "recent" || v === "largest"
}

const PERIOD_OPTIONS: { value: UnshieldingPeriod; label: string }[] = [
  { value: "1h", label: "1H" },
  { value: "12h", label: "12H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "all", label: "ALL" },
]

type AnalysisSnapshot = {
  summary: PostUnshieldSummary
  analysis: UnshieldingsResponse["analysis"]
}

function fmtZec(n: number | null | undefined, suffix = true): string {
  if (n == null || !Number.isFinite(n)) return "--"
  const abs = Math.abs(n)
  const body =
    abs >= 1_000_000
      ? (n / 1_000_000).toFixed(2) + "M"
      : abs >= 1_000
        ? n.toLocaleString("en-US", { maximumFractionDigits: 1 })
        : abs >= 10
          ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
          : n.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return suffix ? `${body} ZEC` : body
}

function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--"
  return n.toLocaleString("en-US")
}

function fmtIsoTime(iso: string | null | undefined): string {
  if (!iso) return "--"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function shortAddress(address: string | null): string {
  if (!address) return "transparent output"
  if (address.length <= 18) return address
  return `${address.slice(0, 10)}...${address.slice(-6)}`
}

function statusMeta(status: PostUnshieldStatus) {
  if (status === "held") {
    return {
      label: "HELD",
      color: paletteVar("cyph"),
      text: "Output still appears unspent.",
    }
  }
  if (status === "spent") {
    return {
      label: "SPENT",
      color: E_STATIC.red,
      text: "Transparent funds moved again.",
    }
  }
  if (status === "reshielded") {
    return {
      label: "RESHIELD",
      color: paletteVar("ratio"),
      text: "Same t-address later moved value into a shielded-touching tx.",
    }
  }
  if (status === "reused") {
    return {
      label: "REUSED",
      color: paletteVar("amber"),
      text: "Recipient t-address had visible prior history.",
    }
  }
  return {
    label: "UNKNOWN",
    color: paletteVar("text"),
    text: "Follow-up state was not confirmed.",
  }
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  color,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  color: string
}) {
  return (
    <div
      className="inline-grid gap-px overflow-hidden"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        border: `1px solid ${color}55`,
      }}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className="px-1.5 md:px-2 py-1 text-[10px] md:text-[11px] tracking-[0.12em] md:tracking-[0.16em] transition-colors"
            style={{
              color: on ? color : paletteVar("text"),
              background: on ? `${color}1a` : "transparent",
              opacity: on ? 1 : 0.65,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function MetricTile({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color: string
}) {
  return (
    <div
      className="border px-2 py-1.5 min-w-0"
      style={{ borderColor: `${color}44`, background: `${color}0a` }}
    >
      <div
        className="text-[9px] md:text-[10px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-lg md:text-2xl font-bold tabular-nums leading-none"
        style={{ color, textShadow: `0 0 8px ${color}44` }}
      >
        {value}
      </div>
      <div
        className="mt-1 text-[10px] md:text-[11px] tabular-nums truncate"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {sub}
      </div>
    </div>
  )
}

function TraceRows({ rows, warming }: { rows: PostUnshieldTrace[]; warming?: boolean }) {
  const isMobile = useIsMobile()
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-[11px]" style={{ opacity: 0.62 }}>
        {warming
          ? "Loading trace outcomes for this window…"
          : "No unshieldings were traced for this page/window."}
      </div>
    )
  }
  return (
    <div className="space-y-px">
      <div
        className="hidden md:grid md:grid-cols-[122px_96px_minmax(0,1fr)_74px_minmax(170px,1fr)_88px] gap-2 px-1 pb-1 text-[10px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.58 }}
      >
        <span>TIME</span>
        <span className="text-right">AMOUNT</span>
        <span>ADDRESS</span>
        <span>STATE</span>
        <span>NEXT / PRIOR</span>
        <span className="text-right">BALANCE</span>
      </div>
      {rows.map((trace) => {
        const meta = statusMeta(trace.status)
        const nextLabel = trace.reshield
          ? `${trace.reshieldType === "full" ? "full" : "partial"} reshield ${shortHash(
              trace.reshield.hash
            )} - ${fmtZec(trace.reshield.amountZec, false)}`
          : trace.nextSpend
          ? `${shortHash(trace.nextSpend.hash)} - ${fmtZec(trace.nextSpend.amountZec, false)}`
          : trace.outputSpent === false
            ? "no later spend seen"
            : "follow-up unknown"
        const actionColor = trace.reshield
          ? paletteVar("ratio")
          : trace.nextSpend
            ? E_STATIC.red
            : paletteVar("text")
        return (
          <a
            key={`${trace.hash}:${trace.address}`}
            href={trace.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="grid grid-cols-1 md:grid-cols-[122px_96px_minmax(0,1fr)_74px_minmax(170px,1fr)_88px] gap-1 md:gap-2 px-1 py-2 text-[11px] md:text-[11px] tabular-nums transition-colors"
            style={{
              borderTop: `1px dotted ${paletteVar("text")}22`,
              color: paletteVar("text"),
            }}
          >
            <span style={{ opacity: 0.68 }}>{fmtIsoTime(trace.time)}</span>
            <span className="font-bold md:text-right" style={{ color: E_STATIC.red }}>
              {fmtZec(trace.amountZec)}
            </span>
            <span className="min-w-0">
              <span className="block truncate" title={trace.address}>
                {shortAddress(trace.address)}
              </span>
              <span className="text-[10px]" style={{ opacity: 0.55 }}>
                {isMobile ? `${shortHash(trace.hash)} - ` : ""}
                {trace.txCount != null ? `${fmtCount(trace.txCount)} tx` : "tx --"}
              </span>
            </span>
            <span className="font-bold tracking-[0.12em]" style={{ color: meta.color }}>
              {meta.label}
              {trace.reshieldType ? (
                <span className="block text-[9px]" style={{ color: paletteVar("ratio") }}>
                  {trace.reshieldType.toUpperCase()}
                </span>
              ) : null}
              {trace.priorShieldSource ? (
                <span className="block text-[9px]" style={{ color: paletteVar("ratio") }}>
                  RETURN?
                </span>
              ) : null}
            </span>
            <span className="min-w-0">
              <span
                className="block truncate"
                style={{
                  color: actionColor,
                  opacity: trace.reshield || trace.nextSpend ? 1 : 0.58,
                }}
              >
                {nextLabel}
              </span>
              {trace.priorShieldSource ? (
                <span
                  className="block truncate text-[10px]"
                  style={{ color: paletteVar("ratio") }}
                >
                  prior shield touch {shortHash(trace.priorShieldSource.hash)}
                </span>
              ) : null}
            </span>
            <span className="md:text-right" style={{ opacity: 0.72 }}>
              <span className="md:hidden">bal </span>
              {trace.balanceZec != null ? fmtZec(trace.balanceZec, false) : "--"}
            </span>
          </a>
        )
      })}
    </div>
  )
}

function LoadingView() {
  return (
    <div className="space-y-3">
      <Skeleton height={100} />
      <Skeleton height={240} />
      <Skeleton height={420} />
    </div>
  )
}

export function Unshieldings() {
  const [poolMode, setPoolModeState] = usePersistentState<PoolMode>(
    "cyphzec.unshieldings.pool.mode",
    "orchard",
    isValidPoolMode
  )
  const [period, setPeriodState] = usePersistentState<UnshieldingPeriod>(
    "cyphzec.unshieldings.period",
    "1d",
    isValidUnshieldingPeriod
  )
  const [sort, setSortState] = usePersistentState<UnshieldingSort>(
    "cyphzec.unshieldings.sort",
    "recent",
    isValidUnshieldingSort
  )
  const [cursorStack, setCursorStack] = useState<
    { cursor: number | null; cursorId: number | null }[]
  >([{ cursor: null, cursorId: null }])
  const [manualRefresh, setManualRefresh] = useState(false)
  const cursor = cursorStack[cursorStack.length - 1]
  const cursorParams =
    cursor.cursor != null
      ? `&cursor=${cursor.cursor}&cursorId=${cursor.cursorId ?? ""}`
      : ""
  const swrKey = `/api/unshieldings?pool=${poolMode}&period=${period}&sort=${sort}&limit=24${cursorParams}`
  const windowKey = `${poolMode}:${period}`
  const bestWindowSnapshots = useRef<Record<string, AnalysisSnapshot>>({})
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<UnshieldingsResponse>(swrKey, swrFetcher, {
      refreshInterval: (latest) =>
        latest?.analysis?.complete && !latest.analysis.refreshing
          ? 60_000
          : 15_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: false,
      dedupingInterval: 10_000,
    })
  const refreshing = manualRefresh || (isValidating && data != null)
  const showingPrevious =
    data != null &&
    (data.pool !== poolMode || data.period !== period || data.sort !== sort)

  useEffect(() => {
    if (!data || showingPrevious) return
    const key = `${data.pool}:${data.period}`
    const current = bestWindowSnapshots.current[key]
    const next = {
      summary: data.postUnshield.summary,
      analysis: data.analysis,
    }
    if (
      !current ||
      data.analysis.total > current.analysis.total ||
      (data.analysis.total === current.analysis.total &&
        data.analysis.analyzed >= current.analysis.analyzed)
    ) {
      bestWindowSnapshots.current[key] = next
    }
  }, [data, showingPrevious])

  const setPoolMode = (next: PoolMode) => {
    setPoolModeState(next)
    setCursorStack([{ cursor: null, cursorId: null }])
  }

  const setPeriod = (next: UnshieldingPeriod) => {
    setPeriodState(next)
    setCursorStack([{ cursor: null, cursorId: null }])
  }

  const setSort = (next: UnshieldingSort) => {
    setSortState(next)
    setCursorStack([{ cursor: null, cursorId: null }])
  }

  const refreshNow = async () => {
    if (manualRefresh) return
    setManualRefresh(true)
    try {
      await mutate(swrFetcher(`${swrKey}&refresh=${Date.now()}`), {
        populateCache: true,
        revalidate: false,
        rollbackOnError: true,
      })
    } finally {
      setManualRefresh(false)
    }
  }

  if (isLoading && !data) return <LoadingView />

  if (error && !data) {
    return (
      <CornerBox label="UNSHIELDINGS" color={E_STATIC.red}>
        <div className="text-sm" style={{ color: E_STATIC.red }}>
          Unshielding monitor upstream is unavailable.
        </div>
        <div className="mt-1 text-[11px]" style={{ opacity: 0.65 }}>
          {error instanceof Error ? error.message : "Unknown error"}
        </div>
      </CornerBox>
    )
  }

  if (!data) return null

  const rawSummary = data.postUnshield.summary
  const rawAnalysis = data.analysis
  const bestSnapshot = bestWindowSnapshots.current[windowKey]
  const canUseBestSnapshot = period === "all"
  const useBestSnapshot =
    canUseBestSnapshot &&
    !showingPrevious &&
    bestSnapshot != null &&
    bestSnapshot.analysis.total >= rawAnalysis.total &&
    bestSnapshot.analysis.analyzed > rawAnalysis.analyzed &&
    (data.stale || rawAnalysis.warming || isValidating)
  const s = useBestSnapshot ? bestSnapshot.summary : rawSummary
  const analysis = useBestSnapshot ? bestSnapshot.analysis : rawAnalysis

  const statusLabel = showingPrevious
    ? "SWITCHING"
    : data.stale || useBestSnapshot
      ? "CACHED"
      : !analysis.complete || analysis.warming || refreshing
        ? "WARMING"
        : "COMPLETE"
  const avgOut =
    data.totals.outTx > 0 ? data.totals.outZec / data.totals.outTx : null
  const coverage =
    analysis.total > 0 ? (analysis.analyzed / analysis.total) * 100 : 100
  const pageOffset = cursor.cursor ?? 0
  const pageStart = data.pagination.returned > 0 ? pageOffset + 1 : 0
  const pageEnd = pageOffset + data.pagination.returned
  return (
    <>
      <div className="mb-2 flex flex-col md:flex-row md:items-start gap-2 md:gap-4">
        <div className="min-w-0 md:flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
                <h1
                  className="text-base font-bold tracking-[0.22em]"
                  style={{ color: E_STATIC.red }}
                >
                  UNSHIELDINGS
                </h1>
                <span
                  className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em]"
                  style={{ color: E_STATIC.red, borderColor: `${E_STATIC.red}66` }}
                >
                  BETA
                </span>
                <span
                  className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em]"
                  style={{
                    color:
                      statusLabel === "COMPLETE"
                        ? paletteVar("cyph")
                        : statusLabel === "CACHED"
                          ? paletteVar("amber")
                          : paletteVar("ratio"),
                    borderColor:
                      statusLabel === "COMPLETE"
                        ? `${paletteVar("cyph")}55`
                        : statusLabel === "CACHED"
                          ? `${paletteVar("amber")}55`
                          : `${paletteVar("ratio")}55`,
                  }}
                >
                  {statusLabel}
                </span>
              </div>
              {/* Period/sort controls on their own row so the LIVE/UPDATING
                  status badge changing width doesn't shift them on mobile. */}
              <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented<PoolMode>
                    value={poolMode}
                    onChange={setPoolMode}
                    color={paletteVar("zec")}
                    options={[
                      { value: "orchard", label: "ORCHARD" },
                      { value: "all", label: "ALL" },
                    ]}
                  />
                  <Segmented<UnshieldingPeriod>
                    value={period}
                    onChange={setPeriod}
                    color={E_STATIC.red}
                    options={PERIOD_OPTIONS}
                  />
                </div>
                <div className="flex">
                  <Segmented<UnshieldingSort>
                    value={sort}
                    onChange={setSort}
                    color={paletteVar("ratio")}
                    options={[
                      { value: "recent", label: "RECENT" },
                      { value: "largest", label: "LARGEST" },
                    ]}
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={refreshNow}
              disabled={manualRefresh}
              aria-label="Refresh unshielding data"
              title="Refresh unshielding data"
              className="inline-flex size-7 shrink-0 items-center justify-center border transition-colors hover:bg-emerald-950/40 disabled:opacity-55 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 md:hidden"
              style={{
                color: refreshing ? paletteVar("cyph") : paletteVar("text"),
                borderColor: refreshing
                  ? `${paletteVar("cyph")}88`
                  : `${paletteVar("text")}33`,
                outlineColor: paletteVar("cyph"),
              }}
            >
              <RefreshCw
                size={13}
                strokeWidth={1.8}
                className={refreshing ? "animate-spin" : undefined}
              />
            </button>
          </div>
          <div
            className="mt-1 max-w-[calc(100vw-24px)] whitespace-normal text-[11px] leading-snug md:max-w-none"
            style={{ color: paletteVar("text"), opacity: 0.66 }}
          >
            <span className="block md:inline">
              Since {data.period === "all" ? "NU6.2 activation" : fmtIsoTime(data.cutoffTime)}.
            </span>
            <span className="hidden md:ml-1 md:inline">
              {showingPrevious
                ? "Keeping the previous snapshot visible while the selected window loads."
                : data.stale
                  ? "Refreshing the selected window in the background."
                  : analysis.warming
                    ? `Warming outcome cache: ${fmtCount(
                        analysis.analyzed
                      )} of ${fmtCount(analysis.total)} classified.`
                    : !analysis.complete
                      ? `Loading cached outcomes: ${fmtCount(
                          analysis.analyzed
                        )} of ${fmtCount(analysis.total)} classified.`
                      : "All outcomes are classified; open addresses recheck automatically."}
            </span>
          </div>
        </div>
        <div className="hidden items-start gap-2 md:flex md:gap-3">
          <button
            type="button"
            onClick={refreshNow}
            disabled={manualRefresh}
            aria-label="Refresh unshielding data"
            title="Refresh unshielding data"
            className="hidden md:inline-flex size-6 shrink-0 items-center justify-center border transition-colors hover:bg-emerald-950/40 disabled:opacity-55 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: refreshing ? paletteVar("cyph") : paletteVar("text"),
              borderColor: refreshing
                ? `${paletteVar("cyph")}88`
                : `${paletteVar("text")}33`,
              outlineColor: paletteVar("cyph"),
            }}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.8}
              className={refreshing ? "animate-spin" : undefined}
            />
          </button>
          <div
            className="text-[11px] tabular-nums"
            style={{ color: paletteVar("text") }}
          >
            <div>
              <div style={{ opacity: 0.55 }}>FETCH</div>
              <div style={{ color: paletteVar("cyph") }}>
                {fmtIsoTime(new Date(data.fetchedAt).toISOString())}
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mb-2 md:mb-3">
        <MetricTile
          label="WINDOW OUT"
          value={fmtZec(data.totals.outZec)}
          sub={data.totals.outUsd != null ? fmtCompactUSD(data.totals.outUsd) : "--"}
          color={E_STATIC.red}
        />
        <MetricTile
          label="OUT TX"
          value={fmtCount(data.totals.outTx)}
          sub={avgOut != null ? `${fmtZec(avgOut)} avg` : "avg --"}
          color={paletteVar("amber")}
        />
        <MetricTile
          label="TX CLASSIFIED"
          value={`${fmtCount(analysis.analyzed)} / ${fmtCount(analysis.total)}`}
          sub={
            analysis.remaining > 0
              ? `${fmtCount(analysis.remaining)} remaining`
              : `${coverage.toFixed(1)}% window coverage`
          }
          color={paletteVar("ratio")}
        />
        <MetricTile
          label="RESHIELD"
          value={fmtCount(s.reshielded)}
          sub={`${fmtCount(s.reshieldedFull)} full / ${fmtCount(s.reshieldedPartial)} partial`}
          color={paletteVar("ratio")}
        />
      </section>

      <div
        className="mb-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-[9px] tracking-[0.12em] md:flex md:text-[10px] md:tracking-[0.15em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        <span className="min-w-0">
          OUTCOME BREAKDOWN
          {!analysis.complete ? (
            <span className="ml-2" style={{ color: paletteVar("amber") }}>
              CACHE {coverage.toFixed(1)}%
            </span>
          ) : analysis.refreshing > 0 ? (
            <span className="ml-2" style={{ color: paletteVar("amber") }}>
              RECHECK {fmtCount(analysis.refreshing)}
            </span>
          ) : null}
        </span>
        <span className="tabular-nums md:ml-auto">
          {fmtZec(s.tracedZec)} CLASSIFIED
        </span>
      </div>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mb-3">
        <MetricTile
          label="HELD"
          value={fmtCount(s.held)}
          sub={fmtZec(s.heldZec)}
          color={paletteVar("cyph")}
        />
        <MetricTile
          label="SPENT"
          value={fmtCount(s.spent)}
          sub={fmtZec(s.spentZec)}
          color={E_STATIC.red}
        />
        <MetricTile
          label="REUSED"
          value={fmtCount(s.reused)}
          sub={fmtZec(s.reusedZec)}
          color={paletteVar("amber")}
        />
        <MetricTile
          label="RESHIELDED"
          value={fmtZec(s.reshieldedZec)}
          sub={`${fmtCount(s.reshielded)} transactions`}
          color={paletteVar("ratio")}
        />
      </section>

      <section className="mb-3">
        <CornerBox
          label="UNSHIELDING TX TRACE"
          color={E_STATIC.red}
          action={
            <div className="flex items-center gap-1.5">
              <span
                className="mr-1 hidden text-[10px] tabular-nums md:inline"
                style={{ color: paletteVar("text"), opacity: 0.58 }}
              >
                {fmtCount(pageStart)}-{fmtCount(pageEnd)} /{" "}
                {fmtCount(data.pagination.total)}
              </span>
              <button
                type="button"
                disabled={cursorStack.length <= 1}
                onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
                className="border px-2 py-1 text-[10px] tracking-[0.14em] disabled:opacity-35"
                style={{ borderColor: `${paletteVar("text")}33` }}
              >
                BACK
              </button>
              <button
                type="button"
                disabled={!data.pagination.hasNext}
                onClick={() => {
                  if (data.pagination.nextCursor == null) return
                  setCursorStack((stack) => [
                    ...stack,
                    {
                      cursor: data.pagination.nextCursor,
                      cursorId: data.pagination.nextCursorId,
                    },
                  ])
                }}
                className="border px-2 py-1 text-[10px] tracking-[0.14em] disabled:opacity-35"
                style={{ borderColor: `${paletteVar("text")}33` }}
              >
                NEXT
              </button>
            </div>
          }
        >
          <TraceRows
            rows={data.postUnshield.traces}
            warming={!data.analysis.complete || data.analysis.warming}
          />
          <div
            className="mt-2 text-[10px] leading-snug"
            style={{ color: paletteVar("text"), opacity: 0.58 }}
          >
            RESHIELD marks a full or partial same-address move back into a
            shielded-touching tx and is not counted as SPENT. SPENT still means
            transparent-chain movement, not proof of sale. RETURN? marks a prior
            shield-touching spend from the same transparent address.
          </div>
        </CornerBox>
      </section>

      <footer
        className="mt-3 flex flex-wrap items-center gap-2 text-[11px]"
        style={{ color: paletteVar("text"), opacity: 0.58 }}
      >
        <Link href="/shielding" className="hover:underline" style={{ color: paletteVar("ratio") }}>
          SHIELDING DETAILS
        </Link>
        <span>/</span>
        <Link href="/stats" className="hover:underline" style={{ color: paletteVar("zec") }}>
          ZEC STATS
        </Link>
        <span className="ml-auto">
          source: CipherScan pools/flows + shielded/list + tx/address
        </span>
      </footer>
    </>
  )
}
