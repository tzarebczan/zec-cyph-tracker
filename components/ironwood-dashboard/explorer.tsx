"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  ArrowRight,
  ArrowUpDown,
  ExternalLink,
  Filter,
  Gauge,
  Radio,
  Search,
  ShieldCheck,
  TimerReset,
  Waves,
  X,
} from "lucide-react"
import useSWR from "swr"
import type {
  IronwoodLiveResponse,
  IronwoodMempoolTx,
  IronwoodMigrationTx,
  IronwoodTxDetail,
} from "@/lib/ironwood-live"
import { CornerBox } from "@/components/primitives"
import { swrFetcher } from "@/components/format"
import { paletteVar } from "@/components/theme"
import {
  CohortTimeline,
  DenominationBars,
  FlowTimeline,
  PrivacyScatter,
} from "./charts"
import {
  type IronwoodWindow,
  ageLabel,
  availableWindows,
  fmtBytes,
  fmtCompact,
  fmtZec,
  formatTime,
  hasCompleteWindowCoverage,
  shortHash,
  txsForWindow,
} from "./utils"

const IRONWOOD = "#f6c945"
const ORCHARD = "#a78bfa"
const CYAN = "#67e8f9"
const RED = "#fb7185"

type ConsoleTab = "live" | "flow" | "privacy" | "audit"
type TxSort = "recent" | "largest"
type PrivacyFilter = "all" | "denominated" | "distinctive"
type SelectedTx =
  | { kind: "confirmed"; tx: IronwoodMigrationTx }
  | { kind: "pending"; tx: IronwoodMempoolTx }

const CONSOLE_TABS: Array<{
  id: ConsoleTab
  label: string
  icon: typeof Activity
}> = [
  { id: "live", label: "LIVE", icon: Radio },
  { id: "flow", label: "FLOW", icon: Waves },
  { id: "privacy", label: "PRIVACY", icon: ShieldCheck },
  { id: "audit", label: "AUDIT", icon: Gauge },
]

export function IronwoodConsole({
  data,
  now,
}: {
  data: IronwoodLiveResponse
  now: number
}) {
  const [tab, setTab] = useState<ConsoleTab>("live")
  const [range, setRange] = useState<IronwoodWindow>("1H")
  const [selectedTx, setSelectedTx] = useState<SelectedTx | null>(null)
  const ranges = useMemo(
    () => availableWindows(data.overview.activated),
    [data.overview.activated]
  )

  useEffect(() => {
    if (!ranges.includes(range)) setRange(ranges.at(-2) ?? "ALL")
  }, [range, ranges])

  const rangeTxs = useMemo(
    () => txsForWindow(data.analytics.transactions, range, now),
    [data.analytics.transactions, now, range]
  )

  return (
    <>
      <div className="mt-3 border-y" style={{ borderColor: `${CYAN}2e` }}>
        <div className="flex min-w-0 items-center justify-between gap-2 overflow-x-auto">
          <div className="flex min-w-max items-center">
            {CONSOLE_TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-pressed={active}
                  className="relative inline-flex min-h-10 items-center gap-1.5 px-3 text-[10px] font-bold tracking-[0.15em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                  style={{
                    color: active ? CYAN : paletteVar("text"),
                    opacity: active ? 1 : 0.55,
                    outlineColor: CYAN,
                  }}
                >
                  <Icon aria-hidden="true" size={12} />
                  {label}
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-2 bottom-0 h-px"
                      style={{ background: CYAN, boxShadow: `0 0 5px ${CYAN}` }}
                    />
                  )}
                </button>
              )
            })}
          </div>
          <div className="hidden shrink-0 items-center gap-1 pr-1 text-[9px] tracking-[0.12em] sm:flex">
            <span
              className="cz-led-pulse inline-block size-1.5 rounded-full"
              style={{ background: data.stale ? IRONWOOD : paletteVar("cyph") }}
            />
            {data.stale ? "STALE FALLBACK" : "STREAM CONNECTED"}
          </div>
        </div>
      </div>

      <div className="mt-3">
        {tab === "live" && (
          <LiveView
            data={data}
            now={now}
            range={range}
            ranges={ranges}
            onRangeChange={setRange}
            onSelectTx={setSelectedTx}
          />
        )}
        {tab === "flow" && (
          <FlowView
            data={data}
            now={now}
            range={range}
            ranges={ranges}
            rangeTxs={rangeTxs}
            onRangeChange={setRange}
          />
        )}
        {tab === "privacy" && (
          <PrivacyView data={data} onSelectTx={(tx) => setSelectedTx({ kind: "confirmed", tx })} />
        )}
        {tab === "audit" && <AuditView data={data} />}
      </div>

      {selectedTx && (
        <TxInspector selected={selectedTx} onClose={() => setSelectedTx(null)} />
      )}
    </>
  )
}

function LiveView({
  data,
  now,
  range,
  ranges,
  onRangeChange,
  onSelectTx,
}: {
  data: IronwoodLiveResponse
  now: number
  range: IronwoodWindow
  ranges: IronwoodWindow[]
  onRangeChange: (range: IronwoodWindow) => void
  onSelectTx: (tx: SelectedTx) => void
}) {
  return (
    <div className="space-y-3">
      <MigrationMempool
        data={data}
        now={now}
        onSelectTx={(tx) => onSelectTx({ kind: "pending", tx })}
      />
      <TransactionFeed
        data={data}
        now={now}
        range={range}
        ranges={ranges}
        onRangeChange={onRangeChange}
        onSelectTx={(tx) => onSelectTx({ kind: "confirmed", tx })}
      />
    </div>
  )
}

function MigrationMempool({
  data,
  now,
  onSelectTx,
}: {
  data: IronwoodLiveResponse
  now: number
  onSelectTx: (tx: IronwoodMempoolTx) => void
}) {
  return (
    <CornerBox
      color={ORCHARD}
      label={
        <span className="inline-flex items-center gap-1.5">
          <TimerReset aria-hidden="true" size={12} />
          MIGRATION MEMPOOL
        </span>
      }
      action={`${data.mempool.migrationCount} PENDING`}
    >
      <div className="mt-2 grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div
          className="grid grid-cols-3 gap-px border"
          style={{ borderColor: `${ORCHARD}2c` }}
        >
          <StatCell
            label="MIG TX"
            value={String(data.mempool.migrationCount)}
            color={ORCHARD}
          />
          <StatCell
            label="PENDING ZEC"
            value={fmtCompact(data.mempool.migrationVolumeZec)}
            color={IRONWOOD}
          />
          <StatCell
            label="ALL MEMPOOL"
            value={String(data.mempool.totalCount)}
          />
        </div>
        {data.mempool.transactions.length ? (
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
            {data.mempool.transactions.slice(0, 8).map((tx) => (
              <button
                key={tx.txid}
                type="button"
                onClick={() => onSelectTx(tx)}
                className="group w-full border px-2 py-2 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{
                  borderColor: `${ORCHARD}35`,
                  outlineColor: ORCHARD,
                  background: `${ORCHARD}06`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[9px]">{shortHash(tx.txid, 7)}</span>
                  <span className="shrink-0 text-[10px] font-bold tabular-nums" style={{ color: IRONWOOD }}>
                    {fmtZec(tx.ironwoodInZec)} ZEC
                  </span>
                </div>
                <div className="mt-1 flex justify-between text-[8px]" style={{ opacity: 0.46 }}>
                  <span>{tx.ironwoodActions} IRONWOOD ACTIONS</span>
                  <span>{ageLabel(tx.timestamp, now)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div
            className="grid min-h-20 place-items-center border text-center text-[9px] leading-relaxed tracking-[0.1em]"
            style={{ borderColor: `${ORCHARD}20`, opacity: 0.44 }}
          >
            <div>
              <Radio aria-hidden="true" size={15} className="mx-auto mb-2 cz-led-pulse" />
              WATCHING FOR ORCHARD TO IRONWOOD
              <br />
              MIGRATION CANDIDATES
            </div>
          </div>
        )}
      </div>
    </CornerBox>
  )
}

function TransactionFeed({
  data,
  now,
  range,
  ranges,
  onRangeChange,
  onSelectTx,
}: {
  data: IronwoodLiveResponse
  now: number
  range: IronwoodWindow
  ranges: IronwoodWindow[]
  onRangeChange: (range: IronwoodWindow) => void
  onSelectTx: (tx: IronwoodMigrationTx) => void
}) {
  const [sort, setSort] = useState<TxSort>("recent")
  const [privacy, setPrivacy] = useState<PrivacyFilter>("all")
  const [query, setQuery] = useState("")
  const rangeRows = useMemo(
    () => txsForWindow(data.analytics.transactions, range, now),
    [data.analytics.transactions, now, range]
  )
  const coverageComplete = hasCompleteWindowCoverage(
    data.analytics.transactions,
    range,
    now
  )
  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const filtered = rangeRows.filter(
      (tx) =>
        (privacy === "all" || tx.privacy === privacy) &&
        (!normalized ||
          tx.txid.toLowerCase().includes(normalized) ||
          String(tx.height).includes(normalized))
    )
    return [...filtered].sort((a, b) =>
      sort === "largest"
        ? b.amountZec - a.amountZec
        : (b.timestamp ?? 0) - (a.timestamp ?? 0)
    )
  }, [privacy, query, sort, rangeRows])
  const totalCount =
    range === "ALL" ? data.overview.migration.txCount : rangeRows.length
  const totalVolume =
    range === "ALL"
      ? data.overview.migration.totalMigratedZec
      : rangeRows.reduce((sum, tx) => sum + tx.amountZec, 0)
  const largest = rangeRows.reduce(
    (max, tx) => Math.max(max, tx.amountZec),
    0
  )

  return (
    <CornerBox
      color={IRONWOOD}
      label="MIGRATION TRANSACTIONS"
      action={
        // Pre-activation there is no feed to be complete or truncated —
        // "WINDOW COMPLETE" over zero rows reads as "nothing happened in
        // this window" rather than "the migration hasn't started".
        data.overview.activated ? (
          <span style={{ color: coverageComplete ? paletteVar("cyph") : IRONWOOD }}>
            {coverageComplete ? "WINDOW COMPLETE" : "LATEST 500 FEED"}
          </span>
        ) : (
          <span style={{ color: IRONWOOD }}>ARMED</span>
        )
      }
    >
      <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <WindowButtons value={range} options={ranges} onChange={onRangeChange} />
        <div className="flex flex-wrap items-center gap-1">
          <SmallToggle
            active={sort === "recent"}
            onClick={() => setSort("recent")}
            label="RECENT"
            icon={ArrowUpDown}
          />
          <SmallToggle
            active={sort === "largest"}
            onClick={() => setSort("largest")}
            label="LARGEST"
            icon={ArrowUpDown}
          />
          <SmallToggle
            active={privacy === "all"}
            onClick={() => setPrivacy("all")}
            label="ALL"
            icon={Filter}
          />
          <SmallToggle
            active={privacy === "denominated"}
            onClick={() => setPrivacy("denominated")}
            label="COMMON"
            icon={Filter}
          />
          <SmallToggle
            active={privacy === "distinctive"}
            onClick={() => setPrivacy("distinctive")}
            label="DISTINCT"
            icon={Filter}
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px border sm:grid-cols-4" style={{ borderColor: `${IRONWOOD}2d` }}>
        <StatCell label={`${range} TX`} value={totalCount.toLocaleString("en-US")} color={CYAN} />
        <StatCell label={`${range} VOLUME`} value={`${fmtCompact(totalVolume)} ZEC`} color={IRONWOOD} />
        <StatCell
          label="AVERAGE"
          value={`${fmtCompact(totalCount > 0 ? totalVolume / totalCount : 0)} ZEC`}
        />
        <StatCell label="LARGEST IN FEED" value={`${fmtCompact(largest)} ZEC`} color={ORCHARD} />
      </div>

      <label className="mt-3 flex h-8 items-center gap-2 border px-2" style={{ borderColor: `${CYAN}2b` }}>
        <Search aria-hidden="true" size={12} style={{ color: CYAN }} />
        <span className="sr-only">Filter migration transactions</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="FILTER TX HASH OR BLOCK"
          className="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:opacity-35"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear transaction filter"
            className="grid size-5 place-items-center focus-visible:outline focus-visible:outline-1"
            style={{ color: CYAN }}
          >
            <X aria-hidden="true" size={11} />
          </button>
        )}
      </label>

      <div className="mt-2">
        <div
          className="hidden grid-cols-[7rem_minmax(10rem,1fr)_7rem_6rem_5rem] gap-3 border-b px-2 py-1 text-[8px] tracking-[0.14em] md:grid"
          style={{ borderColor: `${IRONWOOD}22`, opacity: 0.48 }}
        >
          <span>BLOCK / TIME</span>
          <span>TRANSACTION</span>
          <span className="text-right">MIGRATED</span>
          <span>PRIVACY</span>
          <span className="text-right">AGE</span>
        </div>
        {rows.length ? (
          <div className="divide-y" style={{ borderColor: `${IRONWOOD}1e` }}>
            {rows.slice(0, 120).map((tx) => (
              <button
                key={tx.txid}
                type="button"
                onClick={() => onSelectTx(tx)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 px-2 py-2 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] md:grid-cols-[7rem_minmax(10rem,1fr)_7rem_6rem_5rem] md:items-center md:gap-3"
                style={{ outlineColor: IRONWOOD }}
              >
                <span>
                  <span className="block text-[10px] font-bold tabular-nums" style={{ color: CYAN }}>
                    #{tx.height.toLocaleString("en-US")}
                  </span>
                  <span className="block text-[8px] md:hidden" style={{ opacity: 0.45 }}>
                    {tx.timestamp ? formatTime(tx.timestamp) : "--"}
                  </span>
                </span>
                <span className="min-w-0 md:order-none">
                  <span className="block truncate text-[9px]">{shortHash(tx.txid, 10)}</span>
                </span>
                <span className="text-right text-[10px] font-bold tabular-nums" style={{ color: IRONWOOD }}>
                  {fmtZec(tx.amountZec)} ZEC
                </span>
                <span
                  className="text-[8px] font-bold uppercase"
                  style={{ color: tx.privacy === "denominated" ? paletteVar("cyph") : RED }}
                >
                  {tx.privacy === "denominated" ? "COMMON" : "DISTINCT"}
                </span>
                <span className="text-right text-[9px] tabular-nums" style={{ opacity: 0.48 }}>
                  {tx.timestamp ? ageLabel(tx.timestamp, now) : "--"}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid min-h-40 place-items-center text-center text-[10px] tracking-[0.12em]" style={{ opacity: 0.42 }}>
            {data.overview.activated
              ? "NO MIGRATION TRANSACTIONS MATCH THIS VIEW"
              : `FEED OPENS AT BLOCK ${data.overview.activationHeight.toLocaleString("en-US")}`}
          </div>
        )}
        {rows.length > 120 && (
          <div className="border-t py-2 text-center text-[9px]" style={{ borderColor: `${IRONWOOD}22`, opacity: 0.45 }}>
            SHOWING 120 OF {rows.length.toLocaleString("en-US")} MATCHING TRANSACTIONS
          </div>
        )}
      </div>
    </CornerBox>
  )
}

function FlowView({
  data,
  now,
  range,
  ranges,
  rangeTxs,
  onRangeChange,
}: {
  data: IronwoodLiveResponse
  now: number
  range: IronwoodWindow
  ranges: IronwoodWindow[]
  rangeTxs: IronwoodMigrationTx[]
  onRangeChange: (range: IronwoodWindow) => void
}) {
  const volume =
    range === "ALL"
      ? data.overview.migration.totalMigratedZec
      : rangeTxs.reduce((sum, tx) => sum + tx.amountZec, 0)
  const count =
    range === "ALL" ? data.overview.migration.txCount : rangeTxs.length
  return (
    <div className="space-y-3">
      <CornerBox color={IRONWOOD} label="MIGRATION VELOCITY">
        <div className="mt-2 overflow-x-auto pb-1">
          <WindowButtons
            value={range}
            options={ranges}
            onChange={onRangeChange}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-px border sm:grid-cols-4" style={{ borderColor: `${IRONWOOD}2c` }}>
          <StatCell label={`${range} ZEC`} value={fmtCompact(volume)} color={IRONWOOD} />
          <StatCell label={`${range} TX`} value={count.toLocaleString("en-US")} color={CYAN} />
          <StatCell label="LIVE PACE" value={`${fmtCompact(data.overview.migration.velocityZecPerHour)} ZEC/H`} />
          <StatCell label="MOVED" value={`${data.overview.migration.migratedPercent.toFixed(2)}%`} color={paletteVar("cyph")} />
        </div>
        <div className="mt-4">
          <FlowTimeline transactions={rangeTxs} range={range} now={now} />
        </div>
      </CornerBox>

      <CornerBox color={ORCHARD} label="IRONWOOD INFLOW SOURCES">
        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_18rem]">
          <SourceBars data={data} />
          <div className="grid grid-cols-2 gap-px border" style={{ borderColor: `${ORCHARD}28` }}>
            <StatCell label="TOTAL IN" value={`${fmtCompact(data.overview.inflowSources.totalInZec)} ZEC`} color={IRONWOOD} />
            <StatCell label="TOTAL OUT" value={`${fmtCompact(data.overview.inflowSources.totalOutZec)} ZEC`} color={RED} />
            <StatCell label="ORCHARD TX" value={data.overview.inflowSources.fromOrchardTxs.toLocaleString("en-US")} />
            <StatCell label="OTHER TX" value={(data.overview.inflowSources.fromSaplingTxs + data.overview.inflowSources.fromTransparentTxs + data.overview.inflowSources.fromCoinbaseTxs).toLocaleString("en-US")} />
          </div>
        </div>
      </CornerBox>
    </div>
  )
}

function PrivacyView({
  data,
  onSelectTx,
}: {
  data: IronwoodLiveResponse
  onSelectTx: (tx: IronwoodMigrationTx) => void
}) {
  const analytics = data.analytics
  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <CornerBox
          color={CYAN}
          label={
            <>
              <span className="sm:hidden">PRIVACY SCATTER</span>
              <span className="hidden sm:inline">MIGRATION PRIVACY SCATTER</span>
            </>
          }
          action={`${analytics.transactions.length} RECENT`}
        >
          <div className="mt-3">
            <PrivacyScatter transactions={analytics.transactions} onSelect={onSelectTx} />
          </div>
        </CornerBox>
        <CornerBox color={IRONWOOD} label="AMOUNT PROFILE">
          <div className="mt-2 grid grid-cols-2 gap-px border" style={{ borderColor: `${IRONWOOD}2b` }}>
            <StatCell label="COMMON" value={analytics.denominatedCount.toLocaleString("en-US")} color={paletteVar("cyph")} />
            <StatCell label="DISTINCT" value={analytics.distinctiveCount.toLocaleString("en-US")} color={RED} />
            <StatCell label="COMMON SHARE" value={`${analytics.denominatedPercent.toFixed(0)}%`} color={IRONWOOD} />
            <StatCell label="TOTAL CLASSIFIED" value={analytics.total.toLocaleString("en-US")} />
          </div>
          <div className="mt-4">
            <DenominationBars bins={analytics.denominations} />
          </div>
        </CornerBox>
      </div>
      <CornerBox
        color={ORCHARD}
        label={
          <>
            <span className="sm:hidden">ANCHOR COHORTS</span>
            <span className="hidden sm:inline">ANCHOR-BOUNDARY COHORTS</span>
          </>
        }
        action={
          <>
            <span className="sm:hidden">
              {analytics.boundaryModulus} BLOCKS
            </span>
            <span className="hidden sm:inline">
              {analytics.boundaryModulus} BLOCKS / COHORT
            </span>
          </>
        }
      >
        <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <CohortTimeline cohorts={analytics.cohorts} />
          <div className="grid grid-cols-2 gap-px border" style={{ borderColor: `${ORCHARD}2a` }}>
            <StatCell label="COHORTS" value={analytics.cohortCount.toLocaleString("en-US")} color={ORCHARD} />
            <StatCell label="AVG SET" value={analytics.avgAnonymitySet.toFixed(1)} color={CYAN} />
            <StatCell label="MIN SET" value={analytics.minAnonymitySet.toLocaleString("en-US")} />
            <StatCell label="MAX SET" value={analytics.maxAnonymitySet.toLocaleString("en-US")} />
          </div>
        </div>
        <p className="mt-3 text-[9px] leading-relaxed" style={{ opacity: 0.48 }}>
          COHORT SIZE IS A BLOCK-BOUNDARY PROXY FOR HOW MANY MIGRATIONS SHARE AN ANCHOR WINDOW. A DISTINCTIVE AMOUNT CAN STILL REDUCE PRACTICAL PRIVACY.
        </p>
      </CornerBox>
    </div>
  )
}

function AuditView({ data }: { data: IronwoodLiveResponse }) {
  const [mode, setMode] = useState<"migration" | "overall">("migration")
  const audit = data.overview.supplyAudit
  const verification = data.overview.supplyVerification
  const orchardZec = data.overview.poolSizes.orchardZec
  const ironwoodZec = data.overview.poolSizes.ironwoodZec
  const migrationBaseZec = orchardZec + ironwoodZec
  const migrationVerifiedPct =
    migrationBaseZec > 0 ? (ironwoodZec / migrationBaseZec) * 100 : 0
  const overallVerifiedPct = verification?.verifiedPct ?? 0
  const verifiedPct =
    mode === "migration" ? migrationVerifiedPct : overallVerifiedPct
  const verifiedZec =
    mode === "migration" ? ironwoodZec : verification?.verifiedZec ?? 0
  const remainderZec =
    mode === "migration" ? orchardZec : verification?.unverifiedZec ?? 0
  const verifiedColor =
    mode === "migration" ? IRONWOOD : paletteVar("cyph")
  const statusColor =
    audit.balanced === true
      ? paletteVar("cyph")
      : audit.balanced === false
        ? RED
        : IRONWOOD
  return (
    <div className="space-y-3">
      <CornerBox color={statusColor} label="SUPPLY VERIFICATION">
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div
            className="inline-flex border"
            style={{ borderColor: `${CYAN}35` }}
          >
            {(
              [
                ["migration", "ORCHARD > IRONWOOD"],
                ["overall", "OVERALL"],
              ] as const
            ).map(([value, label]) => {
              const active = mode === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  aria-pressed={active}
                  className="min-h-8 px-3 text-[9px] font-bold tracking-[0.11em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                  style={{
                    color: active ? "#030706" : paletteVar("text"),
                    background: active ? verifiedColor : "transparent",
                    opacity: active ? 1 : 0.58,
                    outlineColor: CYAN,
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <span
            className="inline-flex items-center gap-1.5 text-[9px] font-bold tracking-[0.1em]"
            style={{ color: statusColor }}
          >
            <span
              className="inline-block size-1.5 rounded-full"
              style={{ background: statusColor }}
            />
            {audit.balanced === true
              ? "LEDGER BALANCED"
              : audit.balanced === false
                ? "LEDGER MISMATCH"
                : "LEDGER PENDING"}
          </span>
        </div>
        <div className="mt-3 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-[8px] tracking-[0.16em]" style={{ opacity: 0.5 }}>
                  {mode === "migration"
                    ? "ORCHARD > IRONWOOD VERIFIED"
                    : "OVERALL SUPPLY VERIFIED"}
                </div>
                <div
                  className="mt-1 text-3xl font-bold tabular-nums"
                  style={{ color: verifiedColor }}
                >
                  {verifiedPct.toFixed(3)}%
                </div>
              </div>
              <div className="text-right text-[9px]">
                <div style={{ color: verifiedColor }}>
                  {fmtCompact(verifiedZec)} ZEC VERIFIED
                </div>
                <div className="mt-1" style={{ color: ORCHARD }}>
                  {fmtCompact(remainderZec)} ZEC IN ORCHARD
                </div>
              </div>
            </div>
            <div className="mt-3 flex h-4 overflow-hidden border" style={{ borderColor: `${statusColor}35` }}>
              <div
                className="h-full"
                style={{
                  width: `${Math.max(0, Math.min(100, verifiedPct))}%`,
                  background: verifiedColor,
                }}
              />
              <div className="h-full flex-1" style={{ background: ORCHARD, opacity: 0.68 }} />
            </div>
            <div className="mt-2 flex justify-between text-[8px] tracking-[0.12em]" style={{ opacity: 0.48 }}>
              <span>
                {mode === "migration"
                  ? "IRONWOOD VERIFIED"
                  : "VERIFIED / OUTSIDE ORCHARD"}
              </span>
              <span>ORCHARD REMAINDER</span>
            </div>
            <p
              className="mt-3 max-w-3xl text-[9px] leading-relaxed"
              style={{ opacity: 0.48 }}
            >
              {mode === "migration"
                ? "SHARE OF THE COMBINED ORCHARD + IRONWOOD BALANCE NOW HELD IN IRONWOOD."
                : "SHARE OF TOTAL CHAIN SUPPLY OUTSIDE ORCHARD; ORCHARD IS THE REMAINING UPGRADE-UNVERIFIED BALANCE."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-px border" style={{ borderColor: `${statusColor}2b` }}>
            <StatCell
              label={mode === "migration" ? "MIGRATION BASE" : "CHAIN SUPPLY"}
              value={`${fmtCompact(
                mode === "migration"
                  ? migrationBaseZec
                  : verification?.chainSupplyZec ?? 0
              )} ZEC`}
            />
            <StatCell
              label={mode === "migration" ? "IRONWOOD POOL" : "VERIFIED SUPPLY"}
              value={`${fmtCompact(verifiedZec)} ZEC`}
              color={verifiedColor}
            />
            <StatCell
              label="ORCHARD REMAINS"
              value={`${fmtCompact(remainderZec)} ZEC`}
              color={ORCHARD}
            />
            <StatCell
              label="VERIFIED AT"
              value={`#${audit.accountingHeight.toLocaleString("en-US")}`}
              color={CYAN}
            />
          </div>
        </div>
      </CornerBox>

      <CornerBox color={CYAN} label="TURNSTILE LEDGER">
        {/* The stat row that used to sit here repeated ORCHARD OUT and
            IRONWOOD IN verbatim from the flow nodes below it. The flow keeps
            the numbers; only the terms it can't express get their own cell. */}
        <div className="mt-3 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <LedgerNode label="ORCHARD OUT" value={audit.orchardOutZec} color={ORCHARD} />
          <ArrowRight
            aria-hidden="true"
            className="mx-auto hidden sm:block"
            size={16}
            style={{ color: CYAN }}
          />
          <LedgerNode label="IRONWOOD IN" value={audit.ironwoodInZec} color={IRONWOOD} />
          <ArrowRight
            aria-hidden="true"
            className="mx-auto hidden sm:block"
            size={16}
            style={{ color: CYAN }}
          />
          <LedgerNode
            label="CHAIN IRONWOOD"
            value={audit.authoritativePoolZec}
            color={statusColor}
          />
        </div>

        <InflowReconciliation data={data} />

        <div className="mt-3 grid grid-cols-2 gap-px border" style={{ borderColor: `${CYAN}2b` }}>
          <StatCell
            label="IRONWOOD OUT"
            value={`${fmtZec(audit.ironwoodOutZec, 8)} ZEC`}
            color={audit.ironwoodOutZec > 0 ? RED : undefined}
          />
          <StatCell
            label="UNINDEXED VS CHAIN"
            value={`${fmtZec(audit.differenceZec, 8)} ZEC`}
            color={statusColor}
          />
        </div>
        <p className="mt-3 text-[9px] leading-relaxed" style={{ opacity: 0.48 }}>
          BALANCED MEANS TRACKED IRONWOOD INFLOW MATCHES THE CHAIN-REPORTED
          IRONWOOD POOL AT BLOCK {audit.accountingHeight.toLocaleString("en-US")}.
          ANY REMAINDER IS VALUE THE INDEXER HAS NOT ATTRIBUTED YET.
        </p>
      </CornerBox>
    </div>
  )
}

/** Why IRONWOOD IN doesn't equal ORCHARD OUT.
 *
 *  Two terms sit between them and neither was on screen, which made the gap
 *  look like an unexplained rounding error:
 *   - Orchard is not the only source. Transparent / Sapling / coinbase value
 *     can enter Ironwood directly, pushing IRONWOOD IN above ORCHARD OUT.
 *   - Fees are paid out of the Orchard side, so the value that actually lands
 *     in Ironwood is less than the value that left Orchard.
 *  Showing both makes the arithmetic close on screen. */
function InflowReconciliation({ data }: { data: IronwoodLiveResponse }) {
  const inflows = data.overview.inflowSources
  const audit = data.overview.supplyAudit
  const others = [
    { label: "TRANSPARENT", value: inflows.fromTransparentZec, txs: inflows.fromTransparentTxs },
    { label: "SAPLING", value: inflows.fromSaplingZec, txs: inflows.fromSaplingTxs },
    { label: "COINBASE", value: inflows.fromCoinbaseZec, txs: inflows.fromCoinbaseTxs },
  ].filter((source) => source.value > 0)
  // Value that left Orchard but never arrived in Ironwood — fees, plus any
  // Orchard spend routed elsewhere in the same transaction.
  const orchardLeakZec = audit.orchardOutZec - inflows.fromOrchardZec

  if (inflows.fromOrchardZec <= 0 && !others.length) return null

  return (
    <div
      className="mt-3 border px-2 py-2"
      style={{ borderColor: `${CYAN}22`, background: `${CYAN}05` }}
    >
      <div className="text-[8px] tracking-[0.14em]" style={{ opacity: 0.5 }}>
        IRONWOOD INFLOW RECONCILIATION
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[10px] tabular-nums">
        <LedgerTerm label="FROM ORCHARD" value={inflows.fromOrchardZec} color={ORCHARD} />
        {others.map((source) => (
          <span key={source.label} className="inline-flex items-baseline gap-1">
            <span style={{ opacity: 0.4 }}>+</span>
            <LedgerTerm
              label={source.label}
              value={source.value}
              color={CYAN}
              note={`${source.txs} TX`}
            />
          </span>
        ))}
        <span style={{ opacity: 0.4 }}>=</span>
        <LedgerTerm label="IRONWOOD IN" value={inflows.totalInZec} color={IRONWOOD} />
      </div>
      {orchardLeakZec > 0.00000001 && (
        <div className="mt-1.5 text-[9px] leading-relaxed" style={{ opacity: 0.5 }}>
          {`${fmtZec(orchardLeakZec, 8)} ZEC LEFT ORCHARD WITHOUT ENTERING IRONWOOD — TRANSACTION FEES.`}
        </div>
      )}
    </div>
  )
}

function LedgerTerm({
  label,
  value,
  color,
  note,
}: {
  label: string
  value: number
  color: string
  note?: string
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[8px] tracking-[0.12em]" style={{ opacity: 0.55 }}>
        {label}
      </span>
      <span className="font-bold" style={{ color }}>
        {fmtZec(value, 4)}
      </span>
      {note && (
        <span className="text-[8px]" style={{ opacity: 0.4 }}>
          {note}
        </span>
      )}
    </span>
  )
}

function SourceBars({ data }: { data: IronwoodLiveResponse }) {
  const sources = [
    { label: "ORCHARD", value: data.overview.inflowSources.fromOrchardZec, color: ORCHARD },
    { label: "SAPLING", value: data.overview.inflowSources.fromSaplingZec, color: CYAN },
    { label: "TRANSPARENT", value: data.overview.inflowSources.fromTransparentZec, color: paletteVar("cyph") },
    { label: "COINBASE", value: data.overview.inflowSources.fromCoinbaseZec, color: IRONWOOD },
  ]
  const max = Math.max(...sources.map((source) => source.value), 1)
  return (
    <div className="space-y-2">
      {sources.map((source) => (
        <div key={source.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)_6rem] items-center gap-2 text-[9px]">
          <span>{source.label}</span>
          <div className="h-3" style={{ background: `${source.color}0f` }}>
            <div
              className="h-full transition-[width]"
              style={{
                width: `${Math.max(source.value > 0 ? 1 : 0, (source.value / max) * 100)}%`,
                background: source.color,
                opacity: 0.78,
              }}
            />
          </div>
          <span className="text-right font-bold tabular-nums" style={{ color: source.color }}>
            {fmtCompact(source.value)} ZEC
          </span>
        </div>
      ))}
    </div>
  )
}

function TxInspector({
  selected,
  onClose,
}: {
  selected: SelectedTx
  onClose: () => void
}) {
  const txid = selected.tx.txid
  const { data, error, isLoading } = useSWR<IronwoodTxDetail>(
    selected.kind === "confirmed"
      ? `/api/ironwood/tx?txid=${encodeURIComponent(txid)}`
      : null,
    swrFetcher,
    { revalidateOnFocus: false }
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const amount =
    selected.kind === "confirmed"
      ? selected.tx.amountZec
      : selected.tx.ironwoodInZec
  const height =
    selected.kind === "confirmed" ? selected.tx.height : data?.blockHeight
  const timestamp =
    selected.kind === "confirmed" ? selected.tx.timestamp : selected.tx.timestamp

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Ironwood transaction details"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto border-t p-4 md:inset-y-3 md:right-3 md:left-auto md:w-[28rem] md:max-h-none md:border"
        style={{
          background: "#070a0c",
          borderColor: `${IRONWOOD}66`,
          boxShadow: `0 0 28px ${IRONWOOD}18`,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[8px] tracking-[0.17em]" style={{ opacity: 0.48 }}>
              {selected.kind === "pending" ? "MEMPOOL CANDIDATE" : "CONFIRMED MIGRATION"}
            </div>
            <h2 className="mt-1 text-sm font-bold tracking-[0.12em]" style={{ color: IRONWOOD }}>
              TRANSACTION INSPECTOR
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transaction details"
            className="grid size-8 place-items-center border focus-visible:outline focus-visible:outline-1"
            style={{ borderColor: `${IRONWOOD}55`, color: IRONWOOD, outlineColor: IRONWOOD }}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>

        <div className="mt-4 break-all border px-3 py-2 text-[10px] leading-relaxed" style={{ borderColor: `${CYAN}32`, color: CYAN }}>
          {txid}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-px border" style={{ borderColor: `${IRONWOOD}2d` }}>
          <StatCell label="MIGRATED" value={`${fmtZec(amount)} ZEC`} color={IRONWOOD} />
          <StatCell label="STATUS" value={selected.kind === "pending" ? "PENDING" : "CONFIRMED"} color={selected.kind === "pending" ? ORCHARD : paletteVar("cyph")} />
          <StatCell label="BLOCK" value={height ? `#${height.toLocaleString("en-US")}` : "MEMPOOL"} color={CYAN} />
          <StatCell label="TIME" value={timestamp ? formatTime(timestamp) : "--"} />
        </div>

        {selected.kind === "pending" ? (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3" style={{ borderColor: `${ORCHARD}27` }}>
            <MiniStat label="ORCHARD OUT" value={`${fmtZec(selected.tx.orchardOutZec)} ZEC`} />
            <MiniStat label="IRONWOOD IN" value={`${fmtZec(selected.tx.ironwoodInZec)} ZEC`} />
            <MiniStat label="IRONWOOD ACTIONS" value={String(selected.tx.ironwoodActions)} />
            <MiniStat label="SIZE" value={fmtBytes(selected.tx.size)} />
          </div>
        ) : isLoading ? (
          <div className="mt-4 grid min-h-28 place-items-center text-[9px] tracking-[0.14em]" style={{ opacity: 0.45 }}>
            LOADING CHAIN DETAIL...
          </div>
        ) : error || !data ? (
          <div className="mt-4 border px-3 py-3 text-[9px]" style={{ borderColor: `${RED}42`, color: RED }}>
            CHAIN DETAIL IS TEMPORARILY UNAVAILABLE. THE CONFIRMED MIGRATION RECORD ABOVE IS STILL VALID.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3" style={{ borderColor: `${CYAN}27` }}>
            <MiniStat label="ORCHARD BALANCE" value={`${fmtZec(data.orchardValueBalanceZec)} ZEC`} />
            <MiniStat label="IRONWOOD BALANCE" value={`${fmtZec(data.ironwoodValueBalanceZec)} ZEC`} />
            <MiniStat label="ORCHARD ACTIONS" value={String(data.orchardActions)} />
            <MiniStat label="IRONWOOD ACTIONS" value={String(data.ironwoodActions)} />
            <MiniStat label="SIZE" value={fmtBytes(data.size)} />
            <MiniStat label="FEE" value={`${fmtZec(data.feeZec, 8)} ZEC`} />
            <MiniStat label="TX VERSION" value={String(data.version)} />
            <MiniStat label="CONFIRMATIONS" value={data.confirmations?.toLocaleString("en-US") ?? "--"} />
          </div>
        )}

        <a
          href={`https://cipherscan.app/tx/${txid}`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex min-h-9 w-full items-center justify-center gap-2 border text-[10px] font-bold tracking-[0.13em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
          style={{ color: IRONWOOD, borderColor: `${IRONWOOD}66`, outlineColor: IRONWOOD }}
        >
          OPEN FULL TRANSACTION
          <ExternalLink aria-hidden="true" size={12} />
        </a>
      </div>
    </div>
  )
}

function WindowButtons({
  value,
  options,
  onChange,
}: {
  value: IronwoodWindow
  options: IronwoodWindow[]
  onChange: (range: IronwoodWindow) => void
}) {
  return (
    <div className="flex min-w-max items-center gap-px">
      {options.map((option) => {
        const active = value === option
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            className="min-h-7 border px-2 text-[9px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: active ? IRONWOOD : paletteVar("text"),
              borderColor: active ? `${IRONWOOD}88` : `${paletteVar("text")}22`,
              background: active ? `${IRONWOOD}0c` : "transparent",
              opacity: active ? 1 : 0.55,
              outlineColor: IRONWOOD,
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

function SmallToggle({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: typeof Filter
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex min-h-7 items-center gap-1 border px-2 text-[8px] font-bold tracking-[0.1em] focus-visible:outline focus-visible:outline-1"
      style={{
        color: active ? CYAN : paletteVar("text"),
        borderColor: active ? `${CYAN}66` : `${paletteVar("text")}22`,
        opacity: active ? 1 : 0.5,
        outlineColor: CYAN,
      }}
    >
      <Icon aria-hidden="true" size={9} />
      {label}
    </button>
  )
}

function StatCell({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <div className="min-w-0 px-2 py-2" style={{ background: `${color ?? CYAN}06` }}>
      <div className="truncate text-[8px] tracking-[0.14em]" style={{ opacity: 0.48 }}>
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[11px] font-bold tabular-nums"
        title={value}
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] tracking-[0.14em]" style={{ opacity: 0.45 }}>
        {label}
      </div>
      <div className="mt-0.5 truncate text-[10px] font-bold tabular-nums" title={value}>
        {value}
      </div>
    </div>
  )
}

function LedgerNode({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: string
}) {
  return (
    <div className="border px-3 py-3 text-center" style={{ borderColor: `${color}45`, background: `${color}07` }}>
      <div className="text-[8px] tracking-[0.14em]" style={{ color }}>
        {label}
      </div>
      <div className="mt-1 text-sm font-bold tabular-nums">
        {fmtCompact(value)} ZEC
      </div>
    </div>
  )
}
