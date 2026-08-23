"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  BlockProgress,
  CornerBox,
  InfoTip,
  LiveNumber,
  SimpleLineChartE,
  WindowChips,
  useIsMobile,
  type ChartWindow,
  windowSliceDays,
} from "./primitives"
import { usePersistentState } from "@/lib/use-persistent-state"
import { paletteVar, withAlpha, E_STATIC } from "./theme"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import { computeCyphNav } from "./cyph-nav"
import { MiningPanel } from "./cyph-mining"
import { AnalystCoverage } from "./analyst-coverage"
import { CyphDepthPanel } from "./cyph-depth"
import { CyphFlowPanel } from "./cyph-flow"
import type {
  CyphVolumeResponse,
  CypherpunkMnavResponse,
  HoldingsResponse,
  PricesResponse,
  QuoteSnapshot,
} from "./api-types"

// CYPH's treasury target is framed as 5% of circulating ZEC supply. Keep
// the percentage as the source of truth and derive the ZEC amount from
// the API's circulating-supply field, with the protocol cap as fallback.
const TARGET_SUPPLY_SHARE = 0.05
const FALLBACK_MAX_ZEC_SUPPLY = 21_000_000

// Mobile card groups. /holdings stacks eight cards, which on a phone is a
// very long scroll through material a user mostly wants one slice of at a
// time; grouping them behind tabs puts each answer one tap away. Desktop is
// unchanged — every group renders there, so the grouping is expressed purely
// as a mobile-only hide.
type TreasuryGroup = "position" | "market" | "book" | "history"

const TREASURY_GROUPS: readonly (readonly [TreasuryGroup, string])[] = [
  ["position", "POSITION"],
  ["market", "MARKET"],
  ["book", "BOOK"],
  ["history", "HISTORY"],
]

// v2: v1's seven groups collapsed to four, so a stored "charts" or "flow" is
// no longer a group. Bump the key rather than let the validator silently reset
// every returning reader to POSITION.
const TREASURY_GROUP_KEY = "cyphzec.treasury.group.v2"

// Chart-tab IDs for the TREASURY HISTORY card.
type ChartTab = "zec" | "nav" | "share" | "basis"

export function Treasury() {
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // 90 days of daily closes — enough history to plot the "TREASURY
  // HISTORY · 90D" chart with the four sub-tabs.
  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=all",
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
  const { data: cyphVolume } = useSWR<CyphVolumeResponse>(
    "/api/cyph-volume",
    swrFetcher,
    {
      refreshInterval: 60_000,
      keepPreviousData: true,
    }
  )
  const { data: cypherpunkMnav } = useSWR<CypherpunkMnavResponse>(
    "/api/cypherpunk-mnav",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )

  const [group, setGroup] = usePersistentState<TreasuryGroup>(
    TREASURY_GROUP_KEY,
    "position",
    (v): v is TreasuryGroup =>
      typeof v === "string" && TREASURY_GROUPS.some(([k]) => k === v)
  )
  // The active group carries no class at all and inactive ones only hide
  // below `md`. That means the first paint is already correct on both form
  // factors — a phone shows the active group, a desktop shows everything —
  // so the layout never flashes while JS boots, and the cards stay single
  // instances rather than being duplicated per breakpoint.
  const groupCls = (g: TreasuryGroup) => (g === group ? "" : "max-md:hidden")

  const [chartTab, setChartTab] = useState<ChartTab>("zec")
  const [chartWindow, setChartWindow] = useState<ChartWindow>("90D")
  const [purchasePage, setPurchasePage] = useState(0)
  const isMobile = useIsMobile()
  const chartW = isMobile ? 360 : 900

  const cyphPrice = pickLiveCyph(quote)
  const zecPrice = prices?.current?.zec?.price ?? null
  const totalZec =
    holdings?.summary.totalZec ?? cypherpunkMnav?.zecHoldings ?? null
  const avgCost = holdings?.summary.avgCostPerZec ?? null
  const totalCost = holdings?.summary.totalCostUSD ?? null
  const treasuryUsd =
    totalZec != null && zecPrice != null
      ? totalZec * zecPrice
      : cypherpunkMnav?.netAssetValue ?? null
  const sharesOutstanding = quote?.sharesOutstanding ?? null
  // Our transparent NAV per share: live ZEC treasury ÷ CYPH share counts
  // (common O/S + ITM-diluted, from the 10-Q). Shared with the dashboard
  // tile so both surfaces agree.
  const cyphNav = computeCyphNav({
    treasuryUsd,
    cyphPrice,
    commonSharesLive: sharesOutstanding,
    publishedDilutedShares: cypherpunkMnav?.fullyDilutedShares,
  })
  const pctCirculating = holdings?.supply.pctOfCirculating ?? null
  const maxZecSupply =
    holdings?.supply.max != null && holdings.supply.max > 0
      ? holdings.supply.max
      : FALLBACK_MAX_ZEC_SUPPLY
  const targetPctOfSupply =
    holdings?.supply.targetPct ?? TARGET_SUPPLY_SHARE * 100
  const targetPctLabel = targetPctOfSupply.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })
  const targetSupplyShare = targetPctOfSupply / 100
  const targetSupplyBase =
    holdings?.supply.circulating != null && holdings.supply.circulating > 0
      ? holdings.supply.circulating
      : maxZecSupply
  const isTargetUsingCirculating =
    holdings?.supply.circulating != null && holdings.supply.circulating > 0
  const targetBasisLabel = isTargetUsingCirculating ? "CIRC ZEC" : "MAX ZEC"
  const treasuryTargetZec = targetSupplyBase * targetSupplyShare
  const targetProgressPct =
    totalZec != null && treasuryTargetZec > 0
      ? (totalZec / treasuryTargetZec) * 100
      : null
  const targetRemainingZec =
    totalZec != null ? Math.max(0, treasuryTargetZec - totalZec) : null
  const txs = holdings?.transactions ?? []
  // Sort buys oldest → newest so the cumulative ZEC chart steps up
  // chronologically. Some upstreams return them newest-first.
  const buys = useMemo(
    () =>
      txs
        .filter((t) => t.type === "buy" && (t.amount ?? 0) > 0)
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date)),
    [txs]
  )
  const maxBuy = buys.length > 0 ? Math.max(...buys.map((t) => t.amount ?? 0)) : 0
  const displayBuys = useMemo(
    () => [...buys].sort((a, b) => b.date.localeCompare(a.date)),
    [buys]
  )
  const purchasePageSize = isMobile ? 6 : 10
  const purchasePageCount = Math.max(
    1,
    Math.ceil(displayBuys.length / purchasePageSize)
  )
  const currentPurchasePage = Math.min(purchasePage, purchasePageCount - 1)
  const pagedBuys = displayBuys.slice(
    currentPurchasePage * purchasePageSize,
    currentPurchasePage * purchasePageSize + purchasePageSize
  )
  const shareVolumeDelta = cyphVolume?.deltaVs7dAvgPct ?? null
  const shareVolumeDeltaColor =
    shareVolumeDelta == null
      ? paletteVar("text")
      : shareVolumeDelta >= 0
        ? paletteVar("cyph")
        : E_STATIC.red

  // Unrealized P&L — green/red based on direction. Drives the centre
  // tile's headline tint + "TOTAL PAID / WORTH NOW" mini-grid.
  const unrealized =
    treasuryUsd != null && totalCost != null ? treasuryUsd - totalCost : null
  const unrealizedPct =
    unrealized != null && totalCost != null && totalCost > 0
      ? (unrealized / totalCost) * 100
      : null
  const isGain = unrealized != null && unrealized >= 0

  // mNAV as cypherpunk.com reports it (EV / NAV) — shown as published;
  // their proforma-net-cash EV isn't reproducible from public data. Our
  // own transparent NAV per share (common O/S + ITM-diluted) is computed
  // separately via computeCyphNav above.
  const mnavValue =
    cypherpunkMnav?.mnav ??
    (cypherpunkMnav?.enterpriseValue != null &&
    treasuryUsd != null &&
    treasuryUsd > 0
      ? cypherpunkMnav.enterpriseValue / treasuryUsd
      : null)

  // Build a daily treasury-value series from the buy ledger + the
  // /api/prices history. At each daily close we sum the ZEC
  // accumulated up to that date and multiply by that day's close.
  // Compare against `h.timestamp` (unix-ms) rather than parsing
  // `h.date` — that field is the formatted "May 22" string from the
  // route, which is unparseable and made the prior implementation
  // silently produce all-zero rows. Sharesoutstanding is decoupled
  // from the chart so the ZEC HELD / NAV / P&L tabs render even when
  // /api/quote is unavailable; only the NAV/SHARE tab needs it.
  const treasurySeries = useMemo(() => {
    const history = prices?.history ?? []
    if (history.length === 0 || buys.length === 0) return []
    // Precompute buy timestamps (in ms) once so the inner loop is
    // numeric-only.
    const buysWithTs = buys
      .map((b) => ({
        ts: new Date(b.date.slice(0, 10)).getTime(),
        amount: b.amount ?? 0,
        unitPrice: b.unitPrice ?? 0,
      }))
      .filter((b) => Number.isFinite(b.ts))
    return history.map((h) => {
      const heldThroughDay = buysWithTs.filter((b) => b.ts <= h.timestamp)
      const zecHeld = heldThroughDay.reduce((sum, b) => sum + b.amount, 0)
      const costBasis = heldThroughDay.reduce(
        (sum, b) => sum + b.amount * b.unitPrice,
        0
      )
      const usdValue = zecHeld * h.zec
      return {
        date: h.date,
        timestamp: h.timestamp,
        zec: zecHeld,
        usdValue,
        navPerShare:
          sharesOutstanding != null && sharesOutstanding > 0
            ? usdValue / sharesOutstanding
            : null,
        costBasis,
        pnl: usdValue - costBasis,
      }
    })
  }, [prices, buys, sharesOutstanding])

  // Slice by selected chart window. 1D shows the most recent point
  // only (since prices.history is daily); for longer windows we slice
  // from the end so the chart always ends at "today".
  const windowedSeries = useMemo(() => {
    const days = windowSliceDays(chartWindow)
    if (days == null) return treasurySeries
    return treasurySeries.slice(-days)
  }, [treasurySeries, chartWindow])

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">CYPH TREASURY</h1>
        <span
          className="text-[11px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          Cypherpunk Technologies ZEC holdings · disclosed
        </span>
      </div>

      {/* AT A GLANCE — the numbers a reader came for, kept above the group
          tabs so they survive every tab switch. Grouping the cards into tabs
          otherwise meant landing on HISTORY and seeing no position at all.
          Mobile only: on desktop every card renders anyway, so a summary of
          them would just be a duplicate. */}
      <div
        className="md:hidden mb-2 grid grid-cols-3 gap-px"
        style={{
          border: `1px solid ${withAlpha(paletteVar("amber"), 40)}`,
          background: withAlpha(paletteVar("amber"), 6),
        }}
      >
        <Glance label="ZEC HELD" value={fmtCompactNumber(totalZec)} color={paletteVar("zec")} />
        <Glance label="WORTH" value={fmtCompactUSD(treasuryUsd)} color={paletteVar("amber")} />
        <Glance
          label="P&L"
          value={
            unrealizedPct == null
              ? "—"
              : `${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(1)}%`
          }
          color={isGain ? paletteVar("cyph") : E_STATIC.red}
        />
        <Glance
          label="mNAV"
          value={mnavValue == null ? "—" : `${mnavValue.toFixed(2)}x`}
          color={paletteVar("ratio")}
        />
        <Glance
          label="NAV/SH"
          value={
            cyphNav.navPerShareOS == null
              ? "—"
              : `$${cyphNav.navPerShareOS.toFixed(2)}`
          }
          color={paletteVar("amber")}
        />
        <Glance
          label="CYPH"
          value={cyphPrice == null ? "—" : `$${cyphPrice.toFixed(2)}`}
          color={paletteVar("cyph")}
        />
      </div>

      {/* Mobile group tabs. Hidden from `md` up, where every group renders and
          the tabs would select nothing.

          Deliberately NOT the underline `ETabs` idiom used inside the cards:
          at seven tabs sitting directly above the chart's own ZEC HELD / NAV /
          NAV-SHARE / P&L underline tabs, the two rows read as one
          undifferentiated wall and neither looked like the primary control.
          Segmented buttons put page-level navigation in a visibly different
          register from in-card view switching. */}
      <div className="md:hidden mb-3 flex gap-1">
        {TREASURY_GROUPS.map(([key, label]) => {
          const on = key === group
          return (
            <button
              key={key}
              type="button"
              onClick={() => setGroup(key)}
              aria-pressed={on}
              className="flex-1 border px-1 py-1.5 text-[11px] font-bold tracking-[0.12em] leading-none transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
              style={{
                borderColor: on
                  ? paletteVar("amber")
                  : withAlpha(paletteVar("text"), 27),
                color: on ? paletteVar("amber") : paletteVar("text"),
                background: on ? withAlpha(paletteVar("amber"), 14) : "transparent",
                opacity: on ? 1 : 0.65,
                outlineColor: paletteVar("amber"),
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Top stats — three at-a-glance tiles that surface the three
          questions a user lands on /holdings with: how much ZEC, what
          it's worth vs cost, and what that means per CYPH share. */}
      <div
        className="grid gap-3 mb-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
      >
        {/* HOLDINGS — total ZEC + acquisition target progress bar. */}
        <CornerBox
          label="HOLDINGS"
          color={paletteVar("amber")}
          className={groupCls("position")}
        >
          <div
            className="text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            ZEC IN TREASURY
          </div>
          <div
            className="font-bold text-3xl tabular-nums mt-1"
            style={{
              color: paletteVar("zec"),
              textShadow: `0 0 12px ${paletteVar("zec")}55`,
            }}
          >
            {totalZec != null
              ? Math.round(totalZec).toLocaleString("en-US") + " ZEC"
              : "—"}
          </div>
          {treasuryUsd != null && (
            <div
              className="text-[11px] mt-1"
              style={{ color: paletteVar("text"), opacity: 0.75 }}
            >
              ≈{" "}
              <LiveNumber
                value={treasuryUsd}
                format={fmtCompactUSD}
                color={paletteVar("cyph")}
              />
              {pctCirculating != null && (
                <> · {pctCirculating.toFixed(2)}% circ supply</>
              )}
            </div>
          )}
          {totalZec != null && (
            <div
              className="mt-3 pt-3"
              style={{ borderTop: `1px dotted ${paletteVar("text")}33` }}
            >
              <div className="grid gap-0.5 sm:flex sm:items-baseline sm:justify-between">
                <span
                  className="text-[10px] tracking-[0.15em]"
                  style={{ color: paletteVar("text"), opacity: 0.7 }}
                >
                  {targetPctLabel}% CIRC SUPPLY TARGET
                </span>
                <span
                  className="text-[11px] font-bold tabular-nums sm:text-right"
                  style={{ color: paletteVar("amber") }}
                >
                  {fmtCompactNumber(totalZec)} /{" "}
                  {fmtCompactNumber(treasuryTargetZec)} ZEC
                </span>
              </div>
              <div className="mt-1.5">
                <BlockProgress
                  pct={targetProgressPct ?? 0}
                  width={28}
                  color={paletteVar("amber")}
                  animated
                />
              </div>
              <div
                className="mt-1 text-[11px] font-bold tracking-[0.1em] tabular-nums"
                style={{ color: paletteVar("amber") }}
              >
                {targetProgressPct != null
                  ? targetProgressPct.toFixed(1) + "% TO TARGET"
                  : "TARGET PENDING"}
              </div>
              <div
                className="mt-1 text-[10px] tracking-[0.12em] tabular-nums"
                style={{ color: paletteVar("text"), opacity: 0.55 }}
              >
                BASIS: {targetPctLabel}% x {fmtCompactNumber(targetSupplyBase)}{" "}
                {targetBasisLabel}
              </div>
              <div
                className="mt-2 border px-2 py-1 text-[10px] tabular-nums"
                style={{
                  borderColor: `${paletteVar("text")}22`,
                  color: paletteVar("text"),
                  opacity: 0.72,
                }}
              >
                <div className="grid gap-0.5">
                  <span
                    className="tracking-[0.14em]"
                    style={{ opacity: 0.65 }}
                  >
                    REMAINING TO 5%
                  </span>
                  <span
                    className="font-bold"
                    style={{ color: paletteVar("amber") }}
                  >
                    {targetRemainingZec != null && targetRemainingZec > 0
                      ? fmtCompactNumber(targetRemainingZec) + " ZEC"
                      : "TARGET HIT"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </CornerBox>

        {/* UNREALIZED P&L · LIVE — directional tint, four cells of
            context (avg cost, ZEC now, total paid, worth now). */}
        <CornerBox
          label="UNREALIZED P&L · LIVE"
          color={isGain ? paletteVar("cyph") : E_STATIC.red}
          className={groupCls("position")}
        >
          <div
            className="text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            AT CURRENT ZEC PRICE
          </div>
          <div
            className="font-bold text-3xl tabular-nums mt-1"
            style={{
              color: isGain ? paletteVar("cyph") : E_STATIC.red,
              textShadow: `0 0 12px ${(isGain ? paletteVar("cyph") : E_STATIC.red)}55`,
            }}
          >
            {unrealized != null ? (
              <>
                {isGain ? "▲ " : "▼ "}
                <LiveNumber
                  value={Math.abs(unrealized)}
                  format={fmtCompactUSD}
                  color={isGain ? paletteVar("cyph") : E_STATIC.red}
                />
              </>
            ) : (
              "—"
            )}
          </div>
          {unrealizedPct != null && (
            <div
              className="text-[11px] tabular-nums mt-1"
              style={{ color: isGain ? paletteVar("cyph") : E_STATIC.red }}
            >
              {isGain ? "+" : "-"}
              {Math.abs(unrealizedPct).toFixed(1)}% on cost
            </div>
          )}
          <div
            className="mt-3 grid grid-cols-2 gap-x-3 text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.8 }}
          >
            <MetaCell
              label="AVG COST"
              value={avgCost != null ? "$" + avgCost.toFixed(2) : "—"}
              color={paletteVar("text")}
            />
            <MetaCell
              label="ZEC NOW"
              value={zecPrice != null ? "$" + zecPrice.toFixed(2) : "—"}
              color={paletteVar("zec")}
            />
            <MetaCell
              label="TOTAL PAID"
              value={fmtCompactUSD(totalCost)}
              color={paletteVar("text")}
            />
            <MetaCell
              label="WORTH NOW"
              value={fmtCompactUSD(treasuryUsd)}
              color={paletteVar("cyph")}
            />
          </div>
        </CornerBox>

        {/* mNAV leads (cypherpunk's EV ÷ NAV, shown as published); our own
            transparent NAV per share — common O/S and ITM-diluted, each with
            its discount/premium vs price — sits separately below it. */}
        <CornerBox
          label="mNAV"
          color={paletteVar("ratio")}
          className={`@container ${groupCls("position")}`}
        >
          {/* Lead — mNAV with its formula stated inline; single (i) for how
              cypherpunk builds EV (the one thing that still needs unpacking). */}
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2 min-w-0">
              <span
                className="text-3xl font-bold tabular-nums leading-none"
                style={{
                  color: paletteVar("ratio"),
                  textShadow: `0 0 14px ${paletteVar("ratio")}66`,
                }}
              >
                {mnavValue != null ? (
                  <LiveNumber
                    value={mnavValue}
                    format={(v) => v.toFixed(2) + "x"}
                    color={paletteVar("ratio")}
                  />
                ) : (
                  "--"
                )}
              </span>
              <span
                className="text-[11px] tracking-[0.1em]"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                mNAV = EV &divide; treasury (ZEC)
              </span>
            </div>
            <span className="shrink-0">
              <InfoTip color={paletteVar("ratio")} label="How mNAV is calculated" size={14}>
                <strong style={{ color: paletteVar("ratio") }}>mNAV</strong>{" "}
                is cypherpunk.com&apos;s reported enterprise value &divide; ZEC treasury
                value. Their EV folds in proforma net cash over a diluted share base
                and isn&apos;t reproducible from public data, so it&apos;s shown as
                published. The{" "}
                <strong style={{ color: paletteVar("amber") }}>NAV-per-share</strong>{" "}
                figures below are computed here from the live ZEC treasury and
                CYPH&apos;s share counts.
              </InfoTip>
            </span>
          </div>

          {/* Our NAV per share — deliberately separate from mNAV. Two share
              bases side by side, each over its own signed discount/premium to
              the live price. Common trades below NAV; on a diluted base the
              cheap warrants push per-share backing under the price. */}
          <div
            className="mt-3 pt-3"
            style={{ borderTop: `1px solid ${paletteVar("ratio")}30` }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="text-[11px] tracking-[0.14em] font-bold"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                NAV PER SHARE
              </span>
              <span
                className="text-[10px] tracking-[0.08em] tabular-nums"
                style={{ color: paletteVar("text"), opacity: 0.5 }}
              >
                vs {cyphPrice != null ? "$" + cyphPrice.toFixed(2) : "--"} CYPH
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <TreasuryNavCol
                label="nav/sh (o/s)"
                nav={cyphNav.navPerShareOS}
                vsNavPct={cyphNav.vsNavOSPct}
              />
              <TreasuryNavCol
                label={
                  cyphNav.dilutedSharesSource === "published"
                    ? "nav/sh (dil.)"
                    : "nav/sh (dil. ITM)"
                }
                nav={cyphNav.navPerShareDiluted}
                vsNavPct={cyphNav.vsNavDilutedPct}
              />
            </div>
          </div>

          {/* Footer — inputs behind every figure above; O/S and diluted share
              counts shown together so both NAVs trace to their denominators. */}
          <div
            className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] tracking-[0.08em]"
            style={{ color: paletteVar("text"), opacity: 0.62 }}
          >
            <ValuationTracePill
              label="treasury"
              value={fmtCompactUSD(treasuryUsd)}
              color={paletteVar("amber")}
            />
            <ValuationTracePill
              label="o/s shares"
              value={fmtCompactNumber(cyphNav.commonShares)}
              color={paletteVar("text")}
            />
            <ValuationTracePill
              label="dil. shares"
              value={fmtCompactNumber(cyphNav.dilutedShares)}
              color={paletteVar("ratio")}
            />
          </div>
        </CornerBox>
        {/* ANALYST COVERAGE — rating actions and price targets. */}
        <AnalystCoverage cyphPrice={cyphPrice} className={groupCls("position")} />
        {/* SHARE VOLUME — shares traded over key windows. */}
        <CornerBox
          label="SHARE VOLUME"
          color={paletteVar("cyph")}
          className={groupCls("market")}
        >
          <div
            className="text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            CYPH SHARES TRADED
          </div>
          <div
            className="font-bold text-3xl tabular-nums mt-1"
            style={{
              color: paletteVar("cyph"),
              textShadow: `0 0 12px ${paletteVar("cyph")}55`,
            }}
          >
            {quote?.regularMarketVolume != null
              ? fmtCompactNumber(quote.regularMarketVolume)
              : "—"}
          </div>
          <div
            className="text-[11px] mt-1"
            style={{ color: paletteVar("text"), opacity: 0.75 }}
          >
            since today&apos;s open
          </div>
          <div
            className="mt-3 pt-3 grid grid-cols-2 gap-3"
            style={{ borderTop: `1px dotted ${paletteVar("text")}33` }}
          >
            <div>
              <div
                className="text-[10px]"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                LAST 24H
              </div>
              <div
                className="text-[14px] font-bold tabular-nums"
                style={{ color: paletteVar("cyph") }}
              >
                {cyphVolume?.volume24h != null
                  ? fmtCompactNumber(cyphVolume.volume24h)
                  : "—"}
              </div>
            </div>
            <div>
              <div
                className="text-[10px]"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                LAST 1W
              </div>
              <div
                className="text-[14px] font-bold tabular-nums"
                style={{ color: paletteVar("cyph") }}
              >
                {cyphVolume?.volume1w != null
                  ? fmtCompactNumber(cyphVolume.volume1w)
                  : "—"}
              </div>
            </div>
            <ShareVolumeCell
              label="7D AVG"
              value={
                cyphVolume?.avg7d != null
                  ? fmtCompactNumber(cyphVolume.avg7d)
                  : "—"
              }
              color={paletteVar("cyph")}
            />
            <ShareVolumeCell
              label="VS 7D AVG"
              value={
                shareVolumeDelta != null
                  ? `${shareVolumeDelta >= 0 ? "+" : ""}${shareVolumeDelta.toFixed(1)}%`
                  : "—"
              }
              color={shareVolumeDeltaColor}
            />
          </div>
        </CornerBox>
        {/* MINING — last in the grid and two tracks wide from md up. Four stat
            cells are unreadable in a single 260px auto-fit track, and these are
            estimates rather than headline figures, so the width is better spent
            at the bottom than above the fold. See lib/cyph-mining.ts for why
            the fleet figure is a constant.

            `col-span-2` rather than pinning to the last tracks with
            `grid-column: -3 / -1`: negative line placement adds implicit tracks
            when the grid is one column wide, which pushed the page into ~100px
            of horizontal overflow on a phone. Pinning position is not reliable
            here anyway, since the analyst card above is absent when there is no
            coverage. */}
        <MiningPanel
          zecPrice={zecPrice}
          className={`md:col-span-2 ${groupCls("market")}`}
        />
      </div>

      {/* CYPH ORDER BOOK — its own section rather than a tile in the grid
          above: a ten-level ladder needs the full width to stay legible, and
          on desktop a 260px column would wrap every row. */}
      <CyphDepthPanel className={`mb-3 ${groupCls("book")}`} />

      {/* CYPH ORDER FLOW — executed prints, kept in its own group rather than
          beside the book: the book is T+1 licensed depth and the flow is
          near-live free tape, and putting them in one view invites reading a
          day-old bid against today's prints. */}
      <CyphFlowPanel className={`mb-3 ${groupCls("book")}`} />

      {/* TREASURY HISTORY — four sub-tabs (ZEC HELD / NAV / NAV/SHARE /
          P&L) × selectable window (7D / 30D / 90D / 1Y / ALL). The
          NAV/SHARE tab requires shares-outstanding from /api/quote;
          when that's unavailable the tab still renders but with a
          "data pending" hint instead of a chart. */}
      <CornerBox
        label={`TREASURY HISTORY · ${chartWindow}`}
        color={paletteVar("amber")}
        action={
          <span className="flex flex-wrap items-center gap-2 justify-end">
            {/* Chart-type tabs use the underline-tab convention so
                they read as "which view am I looking at" rather than
                the chip-style toggle the window selector uses below.
                Two visually distinct controls in the same row prevents
                "are these all the same kind of button?" confusion. */}
            <span
              className="flex items-center gap-px border-b"
              style={{ borderColor: `${paletteVar("text")}33` }}
            >
              {(
                [
                  ["zec", "ZEC HELD"],
                  ["nav", "NAV"],
                  ["share", "NAV/SHARE"],
                  ["basis", "P&L"],
                ] as const
              ).map(([v, l]) => {
                const on = chartTab === v
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setChartTab(v)}
                    aria-pressed={on}
                    className="relative px-2 py-1 text-[11px] tracking-[0.1em] font-bold transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                    style={{
                      color: on ? paletteVar("amber") : paletteVar("text"),
                      opacity: on ? 1 : 0.7,
                      textShadow: on ? `0 0 6px ${paletteVar("amber")}55` : "none",
                      outlineColor: paletteVar("amber"),
                    }}
                  >
                    {l}
                    {on && (
                      <span
                        aria-hidden="true"
                        className="absolute left-1 right-1 -bottom-px h-[1px]"
                        style={{
                          background: paletteVar("amber"),
                          boxShadow: `0 0 4px ${paletteVar("amber")}`,
                        }}
                      />
                    )}
                  </button>
                )
              })}
            </span>
            <WindowChips
              value={chartWindow}
              onChange={setChartWindow}
              options={["7D", "30D", "90D", "1Y", "ALL"]}
              color={paletteVar("amber")}
            />
          </span>
        }
        className={`mb-3 ${groupCls("history")}`}
      >
        {chartTab === "share" && sharesOutstanding == null ? (
          <div
            className="text-[11px] py-12 text-center"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            NAV/SHARE needs shares-outstanding from /api/quote. Try
            another chart tab while the upstream catches up.
          </div>
        ) : windowedSeries.length >= 2 ? (
          <>
            {chartTab === "zec" && (
              <SimpleLineChartE
                data={windowedSeries}
                accessor={(d) => d.zec}
                color={paletteVar("zec")}
                height={240}
                format={(v) => (v / 1000).toFixed(0) + "k"}
                label="ZEC"
                viewBoxWidth={chartW}
              />
            )}
            {chartTab === "nav" && (
              <SimpleLineChartE
                data={windowedSeries}
                accessor={(d) => d.usdValue}
                color={paletteVar("cyph")}
                height={240}
                format={fmtCompactUSD}
                label="NAV"
                viewBoxWidth={chartW}
              />
            )}
            {chartTab === "share" && (
              <SimpleLineChartE
                data={windowedSeries.filter((d) => d.navPerShare != null)}
                accessor={(d) => d.navPerShare ?? 0}
                color={paletteVar("ratio")}
                height={240}
                format={(v) => "$" + v.toFixed(2)}
                label="NAV/SH"
                viewBoxWidth={chartW}
              />
            )}
            {chartTab === "basis" && (
              <SimpleLineChartE
                data={windowedSeries}
                accessor={(d) => d.pnl}
                color={paletteVar("amber")}
                height={240}
                format={fmtCompactUSD}
                label="P&L"
                viewBoxWidth={chartW}
              />
            )}
            <div
              className="text-[11px] mt-2"
              style={{ color: paletteVar("text"), opacity: 0.7 }}
            >
              {chartTab === "zec" &&
                "Cumulative disclosed ZEC purchases by date."}
              {chartTab === "nav" &&
                "NAV = ZEC held that day x that day's ZEC close; NAV/share has the same shape because it is NAV scaled by share count."}
              {chartTab === "share" &&
                "NAV/share = NAV divided by current CYPH shares outstanding. Historical share-count series is not available, so older points use today's share count."}
              {chartTab === "basis" &&
                "P&L = marked-to-market NAV minus disclosed acquisition cost basis; it follows NAV until a new buy changes basis."}
            </div>
          </>
        ) : (
          <div
            className="text-[11px] py-12 text-center"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            {treasurySeries.length === 0
              ? "Waiting for /api/prices + acquisition history…"
              : `Not enough data in the ${chartWindow} window — try a longer period.`}
          </div>
        )}
      </CornerBox>

      <CornerBox
        label="ACQUISITION TIMELINE"
        color={paletteVar("amber")}
        className={groupCls("history")}
        action={
          <a
            href="https://cypherpunk.com/investors/sec-filings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] tracking-[0.2em] hover:underline"
            style={{ color: paletteVar("amber") }}
          >
            SEC FILINGS →
          </a>
        }
      >
        {buys.length === 0 ? (
          <div
            className="text-[11px] py-6 text-center"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            Loading acquisition history…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {pagedBuys.map((t) => {
              const amt = t.amount ?? 0
              // Bar visualization — scale each row's amount against
              // the largest disclosed buy so the bars stay legible
              // when one acquisition dwarfs the rest. 24 cells wide
              // matches the BlockProgress sizing convention.
              const fillW = maxBuy > 0 ? Math.round((amt / maxBuy) * 24) : 0
              return (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 transition-colors hover:bg-emerald-950/30"
                  style={{
                    borderBottom: `1px dotted ${paletteVar("text")}22`,
                  }}
                >
                  <span
                    className="text-[11px] tabular-nums"
                    style={{
                      color: paletteVar("text"),
                      opacity: 0.7,
                      minWidth: 80,
                    }}
                  >
                    {t.date.slice(0, 10)}
                  </span>
                  <span
                    className="text-[12px] tabular-nums font-bold"
                    style={{ color: paletteVar("zec"), minWidth: 96 }}
                  >
                    +
                    {amt >= 1000
                      ? (amt / 1000).toFixed(1) + "k"
                      : amt.toFixed(0)}{" "}
                    ZEC
                  </span>
                  <span
                    className="text-[12px] tabular-nums"
                    style={{ minWidth: 72 }}
                  >
                    {t.unitPrice != null ? `@ $${t.unitPrice.toFixed(2)}` : "—"}
                  </span>
                  {t.totalValue != null && (
                    <span
                      className="text-[11px] tabular-nums"
                      style={{
                        color: paletteVar("text"),
                        opacity: 0.7,
                        minWidth: 100,
                      }}
                    >
                      = {fmtCompactUSD(t.totalValue)}
                    </span>
                  )}
                  <div
                    className="whitespace-pre text-[11px] flex-1 min-w-[120px] order-5 md:order-none basis-full md:basis-auto"
                    style={{ color: paletteVar("zec"), opacity: 0.85 }}
                  >
                    {"█".repeat(fillW)}
                    <span style={{ opacity: 0.2 }}>
                      {"░".repeat(24 - fillW)}
                    </span>
                  </div>
                </div>
              )
            })}
            {displayBuys.length > purchasePageSize && (
              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setPurchasePage((p) => Math.max(0, p - 1))}
                  disabled={currentPurchasePage === 0}
                  className="border px-2 py-1 text-[11px] tracking-[0.14em] disabled:cursor-not-allowed"
                  style={{
                    color: paletteVar("amber"),
                    borderColor: `${paletteVar("amber")}55`,
                    opacity: currentPurchasePage === 0 ? 0.35 : 1,
                  }}
                >
                  NEWER
                </button>
                <span
                  className="text-[10px] tracking-[0.14em] tabular-nums"
                  style={{ color: paletteVar("text"), opacity: 0.55 }}
                >
                  {displayBuys.length} PURCHASES
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPurchasePage((p) =>
                      Math.min(purchasePageCount - 1, p + 1)
                    )
                  }
                  disabled={currentPurchasePage >= purchasePageCount - 1}
                  className="border px-2 py-1 text-[11px] tracking-[0.14em] disabled:cursor-not-allowed"
                  style={{
                    color: paletteVar("amber"),
                    borderColor: `${paletteVar("amber")}55`,
                    opacity:
                      currentPurchasePage >= purchasePageCount - 1 ? 0.35 : 1,
                  }}
                >
                  OLDER
                </button>
              </div>
            )}
          </div>
        )}
      </CornerBox>

      <p
        className={`text-[11px] mt-3 ${groupCls("history")}`}
        style={{ color: paletteVar("text"), opacity: 0.4 }}
      >
        Transaction data from{" "}
        <a
          href="https://cypherpunk.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          cypherpunk.com
        </a>
        . ZEC supply from CoinGecko / Cipherscan. Cached at the edge for
        ~6 hours.
      </p>
    </>
  )
}

/** One cell of the mobile AT A GLANCE grid. Deliberately tiny — it exists to
 *  keep six numbers on screen across every tab, not to replace the cards that
 *  explain them. */
function Glance({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <div className="px-2 py-1.5 min-w-0">
      <div
        className="text-[8px] tracking-[0.16em] leading-none"
        style={{ color: paletteVar("text"), opacity: 0.55 }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[13px] font-bold tabular-nums leading-none truncate"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  )
}

function ShareVolumeCell({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <div>
      <div
        className="text-[10px]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {label}
      </div>
      <div className="text-[14px] font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  )
}

// One column of the treasury card's NAV-per-share block: the NAV/share
// value over its signed discount/premium vs the live price (− = below NAV,
// + = above). Kept distinct from mNAV so the two lenses aren't conflated.
function TreasuryNavCol({
  label,
  nav,
  vsNavPct,
}: {
  label: string
  nav: number | null
  vsNavPct: number | null
}) {
  const vsColor =
    vsNavPct == null
      ? paletteVar("text")
      : vsNavPct >= 0
        ? paletteVar("cyph")
        : E_STATIC.red
  return (
    <div className="min-w-0">
      <div
        className="text-[10px] tracking-[0.08em]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[20px] font-bold tabular-nums leading-none"
        style={{ color: paletteVar("amber") }}
      >
        <LiveNumber
          value={nav}
          format={(v) => "$" + v.toFixed(2)}
          color={paletteVar("amber")}
        />
      </div>
      <div
        className="mt-1 text-[11px] font-bold tabular-nums leading-none"
        style={{ color: vsColor, opacity: vsNavPct == null ? 0.55 : 1 }}
      >
        {vsNavPct != null
          ? `${vsNavPct >= 0 ? "+" : ""}${vsNavPct.toFixed(1)}% vs NAV`
          : "-- vs NAV"}
      </div>
    </div>
  )
}

function ValuationTracePill({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: paletteVar("text"), opacity: 0.55 }}>{label}</span>{" "}
      <span className="font-bold tabular-nums" style={{ color }}>
        {value}
      </span>
    </span>
  )
}

function MetaCell({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <div
      className="flex items-center justify-between py-1"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span style={{ color: paletteVar("text"), opacity: 0.65 }}>{label}</span>
      <span className="font-bold tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  )
}

