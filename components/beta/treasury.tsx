"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  BlockProgress,
  CornerBox,
  LiveNumber,
  SimpleLineChartE,
  WindowChips,
  type ChartWindow,
  windowSliceDays,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import type {
  HoldingsResponse,
  PricesResponse,
  QuoteSnapshot,
} from "./api-types"

// Public stated acquisition target for the CYPH treasury — used for
// the HOLDINGS tile's progress bar + "remaining to public target"
// line. Until the company publishes a different number we mirror the
// 500k figure used in the redesign mock; revisit when the next 10-Q
// or press release lands.
const TREASURY_TARGET_ZEC = 500_000

// Chart-tab IDs for the TREASURY HISTORY card.
type ChartTab = "zec" | "nav" | "share" | "basis"

export function BetaTreasury() {
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // 90 days of daily closes — enough history to plot the "TREASURY
  // HISTORY · 90D" chart with the four sub-tabs.
  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=90",
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

  const [chartTab, setChartTab] = useState<ChartTab>("zec")
  const [chartWindow, setChartWindow] = useState<ChartWindow>("90D")

  const cyphPrice = pickLiveCyph(quote)
  const zecPrice = prices?.current?.zec?.price ?? null
  const totalZec = holdings?.summary.totalZec ?? null
  const avgCost = holdings?.summary.avgCostPerZec ?? null
  const totalCost = holdings?.summary.totalCostUSD ?? null
  const treasuryUsd =
    totalZec != null && zecPrice != null ? totalZec * zecPrice : null
  const sharesOutstanding = quote?.sharesOutstanding ?? null
  const navPerShare =
    treasuryUsd != null && sharesOutstanding && sharesOutstanding > 0
      ? treasuryUsd / sharesOutstanding
      : null
  const mcap = quote?.marketCap ?? null
  const pctCirculating = holdings?.supply.pctOfCirculating ?? null
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

  // Unrealized P&L — green/red based on direction. Drives the centre
  // tile's headline tint + "TOTAL PAID / WORTH NOW" mini-grid.
  const unrealized =
    treasuryUsd != null && totalCost != null ? treasuryUsd - totalCost : null
  const unrealizedPct =
    unrealized != null && totalCost != null && totalCost > 0
      ? (unrealized / totalCost) * 100
      : null
  const isGain = unrealized != null && unrealized >= 0

  // Premium/discount vs. NAV per share — same math the dashboard
  // surfaces, repeated here so users landing on /holdings cold can
  // still see whether CYPH is trading at a markup to its book.
  const premiumPct =
    cyphPrice != null && navPerShare != null && navPerShare > 0
      ? ((cyphPrice - navPerShare) / navPerShare) * 100
      : null
  const premiumPositive = premiumPct != null && premiumPct >= 0

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
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          Cypherpunk Technologies ZEC holdings · disclosed
        </span>
      </div>

      {/* Top stats — three at-a-glance tiles that surface the three
          questions a user lands on /holdings with: how much ZEC, what
          it's worth vs cost, and what that means per CYPH share. */}
      <div
        className="grid gap-3 mb-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
      >
        {/* HOLDINGS — total ZEC + acquisition target progress bar. */}
        <CornerBox label="HOLDINGS" color={paletteVar("amber")}>
          <div
            className="text-[10px]"
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
              className="text-[10px] mt-1"
              style={{ color: paletteVar("text"), opacity: 0.75 }}
            >
              ≈{" "}
              <LiveNumber
                value={treasuryUsd}
                format={fmtCompactUSD}
                color={paletteVar("cyph")}
              />
              {pctCirculating != null && (
                <> · {pctCirculating.toFixed(2)}% of supply</>
              )}
            </div>
          )}
          {totalZec != null && (
            <div
              className="mt-3 pt-3"
              style={{ borderTop: `1px dotted ${paletteVar("text")}33` }}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className="text-[9px] tracking-[0.15em]"
                  style={{ color: paletteVar("text"), opacity: 0.7 }}
                >
                  ACQUISITION TARGET
                </span>
                <span
                  className="text-[10px] font-bold tabular-nums"
                  style={{ color: paletteVar("amber") }}
                >
                  {(totalZec / 1000).toFixed(0)}k /{" "}
                  {(TREASURY_TARGET_ZEC / 1000).toFixed(0)}k
                </span>
              </div>
              <div className="mt-1.5">
                <BlockProgress
                  pct={(totalZec / TREASURY_TARGET_ZEC) * 100}
                  width={28}
                  color={paletteVar("amber")}
                  sub={
                    ((totalZec / TREASURY_TARGET_ZEC) * 100).toFixed(1) + "%"
                  }
                />
              </div>
              {totalZec < TREASURY_TARGET_ZEC && (
                <div
                  className="text-[10px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  ~{" "}
                  <span style={{ color: paletteVar("amber") }}>
                    {((TREASURY_TARGET_ZEC - totalZec) / 1000).toFixed(0)}k
                  </span>{" "}
                  ZEC remaining to public target
                </div>
              )}
            </div>
          )}
        </CornerBox>

        {/* UNREALIZED P&L · LIVE — directional tint, four cells of
            context (avg cost, ZEC now, total paid, worth now). */}
        <CornerBox
          label="UNREALIZED P&L · LIVE"
          color={isGain ? paletteVar("cyph") : E_STATIC.red}
        >
          <div
            className="text-[10px]"
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
            className="mt-3 grid grid-cols-2 gap-x-3 text-[10px]"
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

        {/* PER-SHARE — NAV/share with the CYPH price + premium/discount
            chips. Makes the "what is one CYPH worth" question
            answerable from the treasury surface itself. */}
        <CornerBox label="PER-SHARE" color={paletteVar("ratio")}>
          <div
            className="text-[10px]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            NAV / SHARE · LIVE
          </div>
          <div
            className="font-bold text-3xl tabular-nums mt-1"
            style={{
              color: paletteVar("ratio"),
              textShadow: `0 0 12px ${paletteVar("ratio")}55`,
            }}
          >
            {navPerShare != null ? (
              <LiveNumber
                value={navPerShare}
                format={(v) => "$" + v.toFixed(2)}
                color={paletteVar("ratio")}
              />
            ) : (
              "—"
            )}
          </div>
          <div
            className="text-[10px] mt-1"
            style={{ color: paletteVar("text"), opacity: 0.75 }}
          >
            ZEC backing per CYPH share
          </div>
          <div
            className="mt-3 pt-3 grid grid-cols-2 gap-3"
            style={{ borderTop: `1px dotted ${paletteVar("text")}33` }}
          >
            <div>
              <div
                className="text-[9px]"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                CYPH PRICE
              </div>
              <div
                className="text-[14px] font-bold tabular-nums"
                style={{ color: paletteVar("cyph") }}
              >
                {cyphPrice != null ? "$" + cyphPrice.toFixed(2) : "—"}
              </div>
            </div>
            <div>
              <div
                className="text-[9px]"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                {premiumPositive ? "PREMIUM" : "DISCOUNT"} VS NAV
              </div>
              <div
                className="text-[14px] font-bold tabular-nums"
                style={{
                  color: premiumPositive ? paletteVar("cyph") : E_STATIC.red,
                }}
              >
                {premiumPct != null
                  ? `${premiumPositive ? "+" : ""}${premiumPct.toFixed(1)}%`
                  : "—"}
              </div>
            </div>
          </div>
          {treasuryUsd != null && mcap != null && mcap > 0 && (
            <div
              className="mt-3 text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.7 }}
            >
              % of CYPH mcap:{" "}
              <span className="font-bold" style={{ color: paletteVar("ratio") }}>
                {((treasuryUsd / mcap) * 100).toFixed(1)}%
              </span>
            </div>
          )}
        </CornerBox>
      </div>

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
            <span className="flex items-center gap-px">
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
                    className="px-2 py-0.5 text-[10px] tracking-[0.1em] transition-colors"
                    style={{
                      color: on ? paletteVar("amber") : paletteVar("text"),
                      opacity: on ? 1 : 0.65,
                      background: on
                        ? `${paletteVar("amber")}12`
                        : "transparent",
                      border: `1px solid ${on ? `${paletteVar("amber")}55` : "transparent"}`,
                    }}
                  >
                    {l}
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
        className="mb-3"
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
              />
            )}
            <div
              className="text-[10px] mt-2"
              style={{ color: paletteVar("text"), opacity: 0.7 }}
            >
              {chartTab === "zec" &&
                "Cumulative ZEC holdings — step-changes are disclosed acquisitions."}
              {chartTab === "nav" &&
                "Treasury USD value, marked to that day's ZEC close."}
              {chartTab === "share" &&
                "Per-share asset backing (treasury USD ÷ shares outstanding)."}
              {chartTab === "basis" &&
                "Unrealized gain/loss: marked-to-market value minus disclosed cost basis."}
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
        action={
          <a
            href="https://cypherpunk.com/investors/sec-filings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] tracking-[0.2em] hover:underline"
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
            {buys.map((t) => {
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
          </div>
        )}
      </CornerBox>

      <p
        className="text-[10px] mt-3"
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

