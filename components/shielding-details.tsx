"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"
import useSWR from "swr"
import { usePersistentState } from "@/lib/use-persistent-state"
import { CornerBox, Skeleton, useIsMobile } from "./primitives"
import { fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import type {
  ShieldingBlockBucket,
  ShieldingBucket,
  ShieldingDetailsResponse,
  ShieldingFlowTotals,
  ShieldingTransfer,
  UnshieldingsResponse,
} from "./api-types"

type SeriesMode = "hourly" | "daily"
type BlockMode = "topOut" | "topNet" | "latest"
type PoolMode = "orchard" | "all"

function isValidPoolMode(v: unknown): v is PoolMode {
  return v === "orchard" || v === "all"
}

const WINDOW_ROWS: { key: keyof ShieldingDetailsResponse["totals"]; label: string }[] = [
  { key: "lastHour", label: "1H" },
  { key: "last24h", label: "24H" },
  { key: "last7d", label: "7D" },
  { key: "sinceActivation", label: "SINCE NU6.2" },
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

function fmtCompactZec(n: number): string {
  const abs = Math.abs(n)
  const sign = n > 0 ? "+" : n < 0 ? "-" : ""
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`
  if (abs >= 10) return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 1 })}`
  return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 3 })}`
}

function fmtCompactUnsignedZec(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`
  if (abs >= 10) return abs.toLocaleString("en-US", { maximumFractionDigits: 1 })
  return abs.toLocaleString("en-US", { maximumFractionDigits: 3 })
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

function fmtClockTime(iso: string | null | undefined): string {
  if (!iso) return "--"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function bucketLabelParts(
  key: string,
  mode: SeriesMode,
  compact = false
): { main: string; suffix: string | null } {
  if (mode === "daily") return { main: key.slice(5), suffix: null }
  const ms = Date.parse(key)
  if (!Number.isFinite(ms)) return { main: key, suffix: null }
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hour12: true,
  }).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ""
  const period = get("dayPeriod")
  if (compact) {
    return {
      main: `${get("month")}/${get("day")} ${get("hour")}`,
      suffix: period ? period.slice(0, 1).toLowerCase() : null,
    }
  }
  return {
    main: `${get("month")}/${get("day")}, ${get("hour")}`,
    suffix: period || null,
  }
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function shortAddress(address: string | null): string {
  if (!address) return "transparent output"
  if (address.length <= 18) return address
  return `${address.slice(0, 10)}...${address.slice(-6)}`
}

function signedColor(value: number) {
  if (Math.abs(value) < 0.00000001) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
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

function SummaryTile({
  label,
  totals,
  emphasis,
}: {
  label: string
  totals: ShieldingFlowTotals
  emphasis: "out" | "net" | "in"
}) {
  const value =
    emphasis === "out"
      ? totals.outZec
      : emphasis === "in"
        ? totals.inZec
        : totals.netZec
  const color =
    emphasis === "out"
      ? E_STATIC.red
      : emphasis === "in"
        ? paletteVar("cyph")
        : signedColor(value)
  return (
    <div
      className="px-2 py-1.5 md:px-2.5 md:py-2 min-w-0"
      style={{
        border: `1px solid ${color}44`,
        background: `${color}0c`,
      }}
    >
      <div
        className="text-[8px] md:text-[9px] tracking-[0.16em] md:tracking-[0.22em] truncate"
        style={{ color: paletteVar("text"), opacity: 0.65 }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-lg md:text-2xl font-bold tabular-nums leading-none"
        style={{ color, textShadow: `0 0 8px ${color}44` }}
      >
        {emphasis === "net" && value > 0 ? "+" : ""}
        {fmtZec(value)}
      </div>
      <div
        className="mt-1 md:mt-2 text-right text-[9px] md:text-[10px] tabular-nums"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {fmtCompactUSD(emphasis === "out" ? totals.outUsd : totals.netUsd)}
      </div>
    </div>
  )
}

function WindowTotals({ totals }: { totals: ShieldingDetailsResponse["totals"] }) {
  return (
    <CornerBox label="WINDOW TOTALS" color={paletteVar("text")}>
      <div className="grid grid-cols-[82px_1fr_1fr_1fr_54px] gap-2 text-[9px] tracking-[0.16em] mb-1 px-1">
        <span>WINDOW</span>
        <span className="text-right" style={{ color: paletteVar("cyph") }}>IN</span>
        <span className="text-right" style={{ color: E_STATIC.red }}>OUT</span>
        <span className="text-right">NET</span>
        <span className="text-right">TX</span>
      </div>
      <div className="space-y-px">
        {WINDOW_ROWS.map((row) => {
          const t = totals[row.key]
          return (
            <div
              key={row.key}
              className="grid grid-cols-[82px_1fr_1fr_1fr_54px] gap-2 px-1 py-1.5 text-[11px] tabular-nums"
              style={{
                borderTop: `1px dotted ${paletteVar("text")}22`,
                color: paletteVar("text"),
              }}
            >
              <span className="tracking-[0.14em]" style={{ opacity: 0.72 }}>
                {row.label}
              </span>
              <span className="text-right" style={{ color: paletteVar("cyph") }}>
                {fmtZec(t.inZec, false)}
              </span>
              <span className="text-right" style={{ color: E_STATIC.red }}>
                {fmtZec(t.outZec, false)}
              </span>
              <span className="text-right" style={{ color: signedColor(t.netZec) }}>
                {t.netZec > 0 ? "+" : ""}
                {fmtZec(t.netZec, false)}
              </span>
              <span className="text-right">{fmtCount(t.inTx + t.outTx)}</span>
            </div>
          )
        })}
      </div>
    </CornerBox>
  )
}

function FlowBars({
  rows,
  mode,
}: {
  rows: ShieldingBucket[]
  mode: SeriesMode
}) {
  const isMobile = useIsMobile()
  const limit = mode === "hourly" ? (isMobile ? 24 : 48) : isMobile ? 14 : 21
  const visible =
    mode === "hourly" ? [...rows.slice(-limit)].reverse() : rows.slice(-limit)

  if (visible.length === 0) {
    return (
      <div className="py-8 text-center text-[11px]" style={{ opacity: 0.62 }}>
        No shielded flow rows have landed in this window yet.
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div
        className="grid grid-cols-[64px_minmax(0,1fr)_50px] md:grid-cols-[74px_minmax(180px,1fr)_78px_78px_104px] gap-1.5 md:gap-2 px-1 pb-1 text-[8px] md:text-[9px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.62 }}
      >
        <span>{mode === "hourly" ? "TIME" : "DAY"}</span>
        <span>FLOW</span>
        <span className="hidden text-right md:block" style={{ color: paletteVar("cyph") }}>
          IN
        </span>
        <span className="hidden text-right md:block" style={{ color: E_STATIC.red }}>
          OUT
        </span>
        <span className="text-right">NET</span>
      </div>
      {visible.map((row) => {
        const label = bucketLabelParts(row.key, mode, isMobile)
        const totalZec = row.inZec + row.outZec
        const inShare =
          totalZec <= 0 ? 0 : (row.inZec / totalZec) * 100
        const outShare =
          totalZec <= 0 ? 0 : (row.outZec / totalZec) * 100
        return (
          <div
            key={row.key}
            className="grid grid-cols-[64px_minmax(0,1fr)_50px] md:grid-cols-[74px_minmax(180px,1fr)_78px_78px_104px] gap-1.5 md:gap-2 items-center px-1 py-1 text-[9px] md:text-[10px] tabular-nums"
            style={{ borderTop: `1px dotted ${paletteVar("text")}18` }}
          >
            <span
              className="whitespace-nowrap leading-none"
              style={{ color: paletteVar("text"), opacity: 0.65 }}
            >
              {label.main}
              {label.suffix ? (
                <>
                  <span className="align-baseline text-[6px] md:ml-1 md:text-[8px]">
                    {label.suffix}
                  </span>
                </>
              ) : null}
            </span>
            <div
              className="h-2.5 min-w-0"
              style={{ background: `${paletteVar("text")}10` }}
              title={`IN ${fmtZec(row.inZec)} / OUT ${fmtZec(row.outZec)}`}
            >
              <div
                className="flex h-full overflow-hidden"
                style={{ width: totalZec > 0 ? "100%" : "0%" }}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${inShare}%`,
                    background: paletteVar("cyph"),
                    boxShadow: `0 0 6px ${paletteVar("cyph")}66`,
                  }}
                />
                <div
                  className="h-full"
                  style={{
                    width: `${outShare}%`,
                    background: E_STATIC.red,
                    boxShadow: `0 0 6px ${E_STATIC.red}66`,
                  }}
                />
              </div>
            </div>
            <span
              className="hidden text-right md:block"
              style={{ color: paletteVar("cyph") }}
            >
              {fmtCompactUnsignedZec(row.inZec)}
            </span>
            <span className="hidden text-right md:block" style={{ color: E_STATIC.red }}>
              {fmtCompactUnsignedZec(row.outZec)}
            </span>
            <span className="text-right" style={{ color: signedColor(row.netZec) }}>
              {isMobile
                ? fmtCompactZec(row.netZec)
                : `${row.netZec > 0 ? "+" : ""}${fmtZec(row.netZec, false)}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function BlockTable({
  rows,
  mode,
}: {
  rows: ShieldingBlockBucket[]
  mode: BlockMode
}) {
  const isMobile = useIsMobile()
  const limit = isMobile ? 10 : mode === "latest" ? 18 : 12
  const visible = rows.slice(0, limit)
  return (
    <div className="space-y-px">
      <div className="grid grid-cols-[78px_1fr_1fr_1fr_44px] gap-2 text-[9px] tracking-[0.16em] px-1">
        <span>BLOCK</span>
        <span className="text-right" style={{ color: E_STATIC.red }}>OUT</span>
        <span className="text-right" style={{ color: paletteVar("cyph") }}>IN</span>
        <span className="text-right">NET</span>
        <span className="text-right">TX</span>
      </div>
      {visible.map((row) => (
        <a
          key={row.block}
          href={`https://cipherscan.app/block/${row.block}`}
          target="_blank"
          rel="noreferrer"
          className="grid grid-cols-[78px_1fr_1fr_1fr_44px] gap-2 px-1 py-1.5 text-[11px] tabular-nums transition-colors"
          style={{
            borderTop: `1px dotted ${paletteVar("text")}22`,
            color: paletteVar("text"),
          }}
          title={fmtIsoTime(row.time)}
        >
          <span style={{ color: paletteVar("ratio") }}>{row.block}</span>
          <span className="text-right" style={{ color: E_STATIC.red }}>
            {fmtZec(row.outZec, false)}
          </span>
          <span className="text-right" style={{ color: paletteVar("cyph") }}>
            {fmtZec(row.inZec, false)}
          </span>
          <span className="text-right" style={{ color: signedColor(row.netZec) }}>
            {row.netZec > 0 ? "+" : ""}
            {fmtZec(row.netZec, false)}
          </span>
          <span className="text-right">{row.inTx + row.outTx}</span>
        </a>
      ))}
    </div>
  )
}

function TransferRows({
  rows,
  direction,
}: {
  rows: ShieldingTransfer[]
  direction: "in" | "out"
}) {
  const color = direction === "in" ? paletteVar("cyph") : E_STATIC.red
  const isMobile = useIsMobile()
  const visible = rows.slice(0, isMobile ? 10 : 18)
  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-[11px]" style={{ opacity: 0.62 }}>
        No recent {direction === "in" ? "shield-in" : "shield-out"} rows.
      </div>
    )
  }
  return (
    <div className="space-y-px">
      {visible.map((tx) => {
        const primaryRecipient = tx.recipients[0] ?? null
        return (
          <a
            key={tx.hash}
            href={tx.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="grid grid-cols-1 md:grid-cols-[124px_92px_1fr_106px] gap-1 md:gap-3 px-1 py-2 text-[11px] transition-colors"
            style={{
              borderTop: `1px dotted ${paletteVar("text")}22`,
              color: paletteVar("text"),
            }}
          >
            <span className="tabular-nums" style={{ opacity: 0.7 }}>
              {fmtIsoTime(tx.time)}
            </span>
            <span style={{ color: paletteVar("ratio") }}>#{tx.block}</span>
            <span className="min-w-0">
              {direction === "out" ? (
                <>
                  <span className="block truncate" title={primaryRecipient?.recipient ?? undefined}>
                    {shortAddress(primaryRecipient?.recipient ?? null)}
                  </span>
                  {tx.recipients.length > 1 && (
                    <span className="text-[9px]" style={{ opacity: 0.55 }}>
                      +{tx.recipients.length - 1} outputs
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="block truncate">shielded recipient hidden</span>
                  <span className="text-[9px]" style={{ opacity: 0.55 }}>
                    {shortHash(tx.hash)}
                  </span>
                </>
              )}
            </span>
            <span className="md:text-right tabular-nums font-bold" style={{ color }}>
              {fmtZec(tx.amountZec)}
            </span>
          </a>
        )
      })}
    </div>
  )
}

function PostUnshieldMonitor({
  data,
}: {
  data: UnshieldingsResponse | undefined
}) {
  const s = data?.postUnshield.summary
  const analysis = data?.analysis
  const rows = [
    ["HELD", s?.held, paletteVar("cyph")],
    ["SPENT", s?.spent, E_STATIC.red],
    ["RESHIELD", s?.reshielded, paletteVar("ratio")],
    ["REUSED", s?.reused, paletteVar("amber")],
  ] as const

  return (
    <CornerBox
      label="POST-UNSHIELD SUMMARY"
      color={E_STATIC.red}
      action={
        <div className="flex items-center gap-2 text-[9px] tracking-[0.16em] tabular-nums">
          <span style={{ color: E_STATIC.red }}>24H</span>
          <span>
            {analysis
              ? `${fmtCount(analysis.analyzed)} / ${fmtCount(analysis.total)}`
              : "LOADING"}
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-4 gap-1 md:gap-1.5">
        {rows.map(([label, count, color]) => (
          <div
            key={label}
            className="min-w-0 border px-1.5 py-1.5 text-center md:px-2"
            style={{ borderColor: `${color}44`, background: `${color}0a` }}
          >
            <div
              className="text-[8px] tracking-[0.16em]"
              style={{ color: paletteVar("text"), opacity: 0.62 }}
            >
              {label}
            </div>
            <div
              className="mt-1 text-sm font-bold tabular-nums leading-none md:text-base"
              style={{ color: String(color) }}
            >
              {count == null ? "--" : fmtCount(count)}
            </div>
          </div>
        ))}
      </div>
      <Link
        href="/shielding/unshieldings"
        className="mt-2 flex min-h-8 items-center justify-between gap-2 border-t px-1 pt-2 text-[9px] font-bold tracking-[0.14em] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
        style={{
          color: paletteVar("ratio"),
          borderColor: `${paletteVar("text")}22`,
          outlineColor: paletteVar("ratio"),
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span>VIEW UNSHIELDING ANALYSIS</span>
          <span
            className="border px-1 py-0.5 text-[7px]"
            style={{
              color: E_STATIC.red,
              borderColor: `${E_STATIC.red}66`,
            }}
          >
            BETA
          </span>
        </span>
        <span className="shrink-0">OPEN PAGE -&gt;</span>
      </Link>
    </CornerBox>
  )
}

function LoadingView() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={84} />
        ))}
      </div>
      <Skeleton height={320} />
      <Skeleton height={260} />
    </div>
  )
}

export function ShieldingDetails() {
  const [poolMode, setPoolMode] = usePersistentState<PoolMode>(
    "cyphzec.shielding.pool.mode",
    "orchard",
    isValidPoolMode
  )
  const swrKey = `/api/shielding-details?pool=${poolMode}`
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<ShieldingDetailsResponse>(swrKey, swrFetcher, {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    })
  const { data: postUnshieldData } = useSWR<UnshieldingsResponse>(
    `/api/unshieldings?pool=${poolMode}&period=1d&sort=recent&limit=1`,
    swrFetcher,
    {
      refreshInterval: (latest) =>
        latest?.analysis?.complete && !latest.analysis.refreshing
          ? 60_000
          : 15_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    }
  )
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("hourly")
  const [blockMode, setBlockMode] = useState<BlockMode>("topOut")
  const [manualRefresh, setManualRefresh] = useState(false)
  const isMobile = useIsMobile()
  const refreshing = manualRefresh || (isValidating && data != null)

  const refreshNow = async () => {
    if (manualRefresh) return
    setManualRefresh(true)
    try {
      await mutate(
        swrFetcher(`${swrKey}&refresh=${Date.now()}`),
        {
          populateCache: true,
          revalidate: false,
          rollbackOnError: true,
        }
      )
    } finally {
      setManualRefresh(false)
    }
  }

  const series = useMemo(() => {
    if (!data) return []
    return seriesMode === "hourly" ? data.series.hourly : data.series.daily
  }, [data, seriesMode])

  const blockRows = useMemo(() => {
    if (!data) return []
    return data.blocks[blockMode]
  }, [blockMode, data])

  if (isLoading && !data) return <LoadingView />

  if (error && !data) {
    return (
      <CornerBox label="SHIELDING DETAILS" color={E_STATIC.red}>
        <div className="text-sm" style={{ color: E_STATIC.red }}>
          Shielding monitor upstream is unavailable.
        </div>
        <div className="mt-1 text-[11px]" style={{ opacity: 0.65 }}>
          {error instanceof Error ? error.message : "Unknown error"}
        </div>
      </CornerBox>
    )
  }

  if (!data) return null

  const activationTime = fmtIsoTime(data.activation.time)
  const since = data.totals.sinceActivation
  const last24h = data.totals.last24h
  const last7d = data.totals.last7d
  const flowLabel =
    seriesMode === "hourly" ? "FLOW BY HOUR - LOCAL" : "FLOW BY DAY - UTC"

  return (
    <>
      <div className="mb-2 flex flex-col md:flex-row md:items-start gap-2 md:gap-4">
        <div className="min-w-0 md:flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
              <h1
                className="text-base font-bold tracking-[0.22em]"
                style={{ color: paletteVar("ratio") }}
              >
                SHIELDING DETAILS
              </h1>
              <Segmented<PoolMode>
                value={poolMode}
                onChange={setPoolMode}
                color={paletteVar("zec")}
                options={[
                  { value: "orchard", label: "ORCHARD" },
                  { value: "all", label: "ALL" },
                ]}
              />
              {data.stale && (
                <span className="text-[9px] tracking-[0.16em]" style={{ color: E_STATIC.red }}>
                  STALE CACHE
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={refreshNow}
              disabled={manualRefresh}
              aria-label="Refresh shielding data"
              title="Refresh shielding data"
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
            className="mt-1 text-[10px] leading-snug"
            style={{ color: paletteVar("text"), opacity: 0.66 }}
          >
            Total since {data.activation.label} block{" "}
            <a
              href={`https://cipherscan.app/block/${data.activation.block}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
              style={{ color: paletteVar("ratio") }}
            >
              {data.activation.block.toLocaleString("en-US")}
            </a>{" "}
            ({activationTime}).
          </div>
        </div>
        <div className="flex items-start gap-2 md:gap-3">
          <button
            type="button"
            onClick={refreshNow}
            disabled={manualRefresh}
            aria-label="Refresh shielding data"
            title="Refresh shielding data"
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
            className="grid grid-cols-3 gap-2 md:gap-3 text-[10px] tabular-nums"
            style={{ color: paletteVar("text") }}
          >
            <div>
              <div style={{ opacity: 0.55 }}>CHAIN</div>
              <div style={{ color: paletteVar("ratio") }}>
                {data.network.blockHeight?.toLocaleString("en-US") ?? "--"}
              </div>
            </div>
            <div>
              <div style={{ opacity: 0.55 }}>ZEC</div>
              <div style={{ color: paletteVar("zec") }}>
                {data.network.priceUsd != null
                  ? "$" + data.network.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })
                  : "--"}
              </div>
            </div>
            <div>
              <div style={{ opacity: 0.55 }}>FETCH</div>
              <div style={{ color: paletteVar("cyph") }}>
                {isMobile
                  ? fmtClockTime(new Date(data.fetchedAt).toISOString())
                  : fmtIsoTime(new Date(data.fetchedAt).toISOString())}
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mb-2 md:mb-3">
        <SummaryTile label="OUT 24H" totals={last24h} emphasis="out" />
        <SummaryTile label="NET 24H" totals={last24h} emphasis="net" />
        <SummaryTile label="OUT 7D" totals={last7d} emphasis="out" />
        <SummaryTile label="NET SINCE NU6.2" totals={since} emphasis="net" />
      </section>

      <section className="mb-2 md:mb-3">
        <PostUnshieldMonitor data={postUnshieldData} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1.35fr_0.9fr] gap-3 mb-2 md:mb-3">
        <CornerBox
          label={flowLabel}
          color={paletteVar("ratio")}
          action={
            <Segmented<SeriesMode>
              value={seriesMode}
              onChange={setSeriesMode}
              color={paletteVar("ratio")}
              options={[
                { value: "hourly", label: "HOUR" },
                { value: "daily", label: "DAY" },
              ]}
            />
          }
        >
          <FlowBars rows={series} mode={seriesMode} />
        </CornerBox>

        <WindowTotals totals={data.totals} />
      </section>

      <section className="mb-3">
        <CornerBox
          label="RECENT BLOCK SPIKES"
          color={paletteVar("amber")}
          action={
            <Segmented<BlockMode>
              value={blockMode}
              onChange={setBlockMode}
              color={paletteVar("amber")}
              options={[
                { value: "topOut", label: "OUT" },
                { value: "topNet", label: "NET" },
                { value: "latest", label: "LATEST" },
              ]}
            />
          }
        >
          <BlockTable rows={blockRows} mode={blockMode} />
        </CornerBox>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <CornerBox label="RECENT UNSHIELDING OUT" color={E_STATIC.red}>
          <TransferRows rows={data.recentOut} direction="out" />
        </CornerBox>
        <CornerBox label="RECENT SHIELDING IN" color={paletteVar("cyph")}>
          <TransferRows rows={data.recentIn} direction="in" />
        </CornerBox>
      </section>

      <footer
        className="mt-3 flex flex-wrap items-center gap-2 text-[10px]"
        style={{ color: paletteVar("text"), opacity: 0.58 }}
      >
        <Link href="/stats" className="hover:underline" style={{ color: paletteVar("zec") }}>
          ZEC STATS
        </Link>
        <span>/</span>
        <Link href="/" className="hover:underline" style={{ color: paletteVar("cyph") }}>
          DASHBOARD
        </Link>
        <span className="ml-auto">
          source: CipherScan pools/flows + shielded/list
        </span>
      </footer>
    </>
  )
}
