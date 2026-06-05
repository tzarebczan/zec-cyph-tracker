"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import useSWR from "swr"
import { CornerBox, Skeleton, useIsMobile } from "./primitives"
import { fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import type {
  ShieldingBlockBucket,
  ShieldingBucket,
  ShieldingDetailsResponse,
  ShieldingFlowTotals,
  ShieldingTransfer,
} from "./api-types"

type SeriesMode = "hourly" | "daily"
type BlockMode = "topOut" | "topNet" | "latest"

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

function fmtIsoTime(iso: string | null | undefined): string {
  if (!iso) return "--"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  })
}

function fmtClockTime(iso: string | null | undefined): string {
  if (!iso) return "--"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "--"
  return new Date(ms).toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  })
}

function fmtBucketLabel(key: string, mode: SeriesMode): string {
  if (mode === "daily") return key.slice(5)
  const ms = Date.parse(key)
  if (!Number.isFinite(ms)) return key
  return new Date(ms).toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    hour12: false,
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
  const limit = mode === "hourly" ? (isMobile ? 24 : 48) : 14
  const visible =
    mode === "hourly" ? [...rows.slice(-limit)].reverse() : rows.slice(-limit)
  const max = Math.max(
    1,
    ...visible.map((row) => Math.max(row.inZec, row.outZec))
  )

  if (visible.length === 0) {
    return (
      <div className="py-8 text-center text-[11px]" style={{ opacity: 0.62 }}>
        No shielded flow rows have landed in this window yet.
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {visible.map((row) => {
        const barPct = (value: number) =>
          value <= 0 ? 0 : Math.max(1, (value / max) * 100)
        const inPct = barPct(row.inZec)
        const outPct = barPct(row.outZec)
        return (
          <div
            key={row.key}
            className="grid grid-cols-[46px_1fr_54px] md:grid-cols-[82px_1fr_110px] gap-1.5 md:gap-2 items-center text-[9px] md:text-[10px] tabular-nums"
          >
            <span style={{ color: paletteVar("text"), opacity: 0.65 }}>
              {fmtBucketLabel(row.key, mode)}
            </span>
            <div className="grid grid-rows-2 gap-px min-w-0">
              <div
                className="h-2"
                style={{ background: `${paletteVar("cyph")}14` }}
                title={`IN ${fmtZec(row.inZec)}`}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${inPct}%`,
                    background: paletteVar("cyph"),
                    boxShadow: `0 0 6px ${paletteVar("cyph")}66`,
                  }}
                />
              </div>
              <div
                className="h-2"
                style={{ background: `${E_STATIC.red}14` }}
                title={`OUT ${fmtZec(row.outZec)}`}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${outPct}%`,
                    background: E_STATIC.red,
                    boxShadow: `0 0 6px ${E_STATIC.red}66`,
                  }}
                />
              </div>
            </div>
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
          href={`https://blockchair.com/zcash/block/${row.block}`}
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
            href={tx.blockchairUrl}
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
  const { data, error, isLoading } = useSWR<ShieldingDetailsResponse>(
    "/api/shielding-details",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("hourly")
  const [blockMode, setBlockMode] = useState<BlockMode>("topOut")
  const isMobile = useIsMobile()

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
    seriesMode === "hourly" ? "FLOW BY HOUR · LOCAL" : "FLOW BY DAY · UTC"

  return (
    <>
      <div className="mb-2 flex flex-col md:flex-row md:items-end gap-1.5 md:gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1
              className="text-base font-bold tracking-[0.22em]"
              style={{ color: paletteVar("ratio") }}
            >
              SHIELDING DETAILS
            </h1>
            {data.stale && (
              <span className="text-[9px] tracking-[0.16em]" style={{ color: E_STATIC.red }}>
                STALE CACHE
              </span>
            )}
          </div>
          <div
            className="mt-1 text-[10px] leading-snug"
            style={{ color: paletteVar("text"), opacity: 0.66 }}
          >
            Since {data.activation.label} block{" "}
            <a
              href={`https://blockchair.com/zcash/block/${data.activation.block}`}
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
        <div
          className="md:ml-auto grid grid-cols-3 gap-2 md:gap-3 text-[10px] tabular-nums"
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

      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2 mb-2 md:mb-3">
        <SummaryTile label="OUT 24H" totals={last24h} emphasis="out" />
        <SummaryTile label="NET 24H" totals={last24h} emphasis="net" />
        <SummaryTile label="OUT 7D" totals={last7d} emphasis="out" />
        <SummaryTile label="NET SINCE NU6.2" totals={since} emphasis="net" />
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
          <div className="mb-2 flex items-center gap-3 text-[9px] tracking-[0.16em]">
            <span style={{ color: paletteVar("cyph") }}>IN</span>
            <span style={{ color: E_STATIC.red }}>OUT</span>
            <span style={{ color: paletteVar("text"), opacity: 0.55 }}>
              NET
            </span>
          </div>
          <FlowBars rows={series} mode={seriesMode} />
        </CornerBox>

        <WindowTotals totals={data.totals} />
      </section>

      <section className="mb-3">
        <CornerBox
          label="BLOCK SPIKES"
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
        <span className="ml-auto">source: Blockchair zcash transactions + dashboards API</span>
      </footer>
    </>
  )
}
