"use client"

import Link from "next/link"
import { useState } from "react"
import { RefreshCw } from "lucide-react"
import useSWR from "swr"
import { CornerBox, Skeleton, useIsMobile } from "./primitives"
import { fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import type {
  PostUnshieldStatus,
  PostUnshieldTrace,
  UnshieldingPeriod,
  UnshieldingsResponse,
} from "./api-types"

type PoolMode = "orchard" | "all"

const PERIOD_OPTIONS: { value: UnshieldingPeriod; label: string }[] = [
  { value: "1h", label: "1H" },
  { value: "12h", label: "12H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "all", label: "ALL" },
]

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
            className="px-1.5 md:px-2 py-1 text-[9px] md:text-[10px] tracking-[0.12em] md:tracking-[0.16em] transition-colors"
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
        className="text-[8px] md:text-[9px] tracking-[0.16em]"
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
        className="mt-1 text-[9px] md:text-[10px] tabular-nums truncate"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        {sub}
      </div>
    </div>
  )
}

function TraceRows({ rows }: { rows: PostUnshieldTrace[] }) {
  const isMobile = useIsMobile()
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-[11px]" style={{ opacity: 0.62 }}>
        No unshieldings were traced for this page/window.
      </div>
    )
  }
  return (
    <div className="space-y-px">
      <div
        className="hidden md:grid md:grid-cols-[122px_96px_minmax(0,1fr)_74px_minmax(170px,1fr)_88px] gap-2 px-1 pb-1 text-[9px] tracking-[0.16em]"
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
        const nextLabel = trace.nextSpend
          ? `${shortHash(trace.nextSpend.hash)} - ${fmtZec(trace.nextSpend.amountZec, false)}`
          : trace.outputSpent === false
            ? "no later spend seen"
            : "follow-up unknown"
        return (
          <a
            key={`${trace.hash}:${trace.address}`}
            href={trace.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="grid grid-cols-1 md:grid-cols-[122px_96px_minmax(0,1fr)_74px_minmax(170px,1fr)_88px] gap-1 md:gap-2 px-1 py-2 text-[10px] md:text-[11px] tabular-nums transition-colors"
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
              <span className="text-[9px]" style={{ opacity: 0.55 }}>
                {isMobile ? `${shortHash(trace.hash)} - ` : ""}
                {trace.txCount != null ? `${fmtCount(trace.txCount)} tx` : "tx --"}
              </span>
            </span>
            <span className="font-bold tracking-[0.12em]" style={{ color: meta.color }}>
              {meta.label}
              {trace.priorShieldSource ? (
                <span className="block text-[8px]" style={{ color: paletteVar("ratio") }}>
                  RETURN?
                </span>
              ) : null}
            </span>
            <span className="min-w-0">
              <span
                className="block truncate"
                style={{
                  color: trace.nextSpend ? E_STATIC.red : paletteVar("text"),
                  opacity: trace.nextSpend ? 1 : 0.58,
                }}
              >
                {nextLabel}
              </span>
              {trace.priorShieldSource ? (
                <span
                  className="block truncate text-[9px]"
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
  const [poolMode, setPoolModeState] = useState<PoolMode>("orchard")
  const [period, setPeriodState] = useState<UnshieldingPeriod>("1d")
  const [cursorStack, setCursorStack] = useState<
    { cursor: number | null; cursorId: number | null }[]
  >([{ cursor: null, cursorId: null }])
  const [manualRefresh, setManualRefresh] = useState(false)
  const cursor = cursorStack[cursorStack.length - 1]
  const cursorParams =
    cursor.cursor != null
      ? `&cursor=${cursor.cursor}&cursorId=${cursor.cursorId ?? ""}`
      : ""
  const swrKey = `/api/unshieldings?pool=${poolMode}&period=${period}&limit=24${cursorParams}`
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<UnshieldingsResponse>(swrKey, swrFetcher, {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    })
  const refreshing = manualRefresh || (isValidating && data != null)

  const setPoolMode = (next: PoolMode) => {
    setPoolModeState(next)
    setCursorStack([{ cursor: null, cursorId: null }])
  }

  const setPeriod = (next: UnshieldingPeriod) => {
    setPeriodState(next)
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

  const s = data.postUnshield.summary
  const avgOut =
    data.totals.outTx > 0 ? data.totals.outZec / data.totals.outTx : null
  return (
    <>
      <div className="mb-2 flex flex-col md:flex-row md:items-end gap-1.5 md:gap-4">
        <div className="min-w-0 md:flex-1">
          <div className="flex w-full items-start justify-between gap-2">
            <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
              <h1
                className="text-base font-bold tracking-[0.22em]"
                style={{ color: E_STATIC.red }}
              >
                UNSHIELDINGS
              </h1>
              <span
                className="border px-1.5 py-0.5 text-[8px] font-bold tracking-[0.16em]"
                style={{ color: E_STATIC.red, borderColor: `${E_STATIC.red}66` }}
              >
                BETA
              </span>
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
            <button
              type="button"
              onClick={refreshNow}
              disabled={manualRefresh}
              aria-label="Refresh unshielding data"
              title="Refresh unshielding data"
              className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center border transition-colors hover:bg-emerald-950/40 disabled:opacity-55 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 md:size-6"
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
            className="mt-1 text-[10px] leading-snug"
            style={{ color: paletteVar("text"), opacity: 0.66 }}
          >
            Since {period === "all" ? "NU6.2 activation" : fmtIsoTime(data.cutoffTime)}.
            <span> </span>
            Scenario totals below are traced from the visible paginated rows.
          </div>
        </div>
        <div
          className="md:ml-auto grid grid-cols-2 gap-2 md:gap-3 text-[10px] tabular-nums"
          style={{ color: paletteVar("text") }}
        >
          <div>
            <div style={{ opacity: 0.55 }}>FETCH</div>
            <div style={{ color: paletteVar("cyph") }}>
              {fmtIsoTime(new Date(data.fetchedAt).toISOString())}
            </div>
          </div>
          <div>
            <div style={{ opacity: 0.55 }}>ROWS</div>
            <div style={{ color: paletteVar("ratio") }}>
              {fmtCount(data.pagination.returned)}
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
          label="TRACED PAGE"
          value={fmtCount(s.traced)}
          sub={`${fmtZec(s.tracedZec)} checked`}
          color={paletteVar("ratio")}
        />
        <MetricTile
          label="RETURN?"
          value={fmtCount(s.priorShieldSource)}
          sub="same t-addr signal"
          color={paletteVar("cyph")}
        />
      </section>

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
          label="UNKNOWN"
          value={fmtCount(s.unknown)}
          sub="needs follow-up"
          color={paletteVar("text")}
        />
      </section>

      <section className="mb-3">
        <CornerBox
          label="UNSHIELDING TX TRACE"
          color={E_STATIC.red}
          action={
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={cursorStack.length <= 1}
                onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
                className="border px-2 py-1 text-[9px] tracking-[0.14em] disabled:opacity-35"
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
                className="border px-2 py-1 text-[9px] tracking-[0.14em] disabled:opacity-35"
                style={{ borderColor: `${paletteVar("text")}33` }}
              >
                NEXT
              </button>
            </div>
          }
        >
          <TraceRows rows={data.postUnshield.traces} />
          <div
            className="mt-2 text-[9px] leading-snug"
            style={{ color: paletteVar("text"), opacity: 0.58 }}
          >
            SPENT means transparent-chain movement after deshielding, not proof
            of sale. RETURN? marks a prior shield-touching spend from the same
            transparent address. Use NEXT to page backward through events since
            NU6.2.
          </div>
        </CornerBox>
      </section>

      <footer
        className="mt-3 flex flex-wrap items-center gap-2 text-[10px]"
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
