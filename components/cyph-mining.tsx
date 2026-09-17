"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Pickaxe } from "lucide-react"
import useSWR from "swr"
import type { ZecMiningResponse } from "@/app/api/zec-mining/route"
import type { HoldingsResponse, PricesResponse } from "./api-types"
import {
  CornerBox,
  InfoTip,
  SimpleLineChartE,
  Skeleton,
  useIsMobile,
} from "./primitives"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar, withAlpha } from "./theme"
import {
  estimateCyphMining,
  type CyphMiningEstimate,
} from "@/lib/cyph-mining"

const MINING = "#f59e0b"

/** Shared SWR config. Network hashrate drifts slowly; no need to be eager. */
const MINING_SWR = {
  refreshInterval: 5 * 60_000,
  keepPreviousData: true,
  revalidateOnFocus: true,
} as const

export function useCyphMining(): {
  estimate: CyphMiningEstimate | null
  network: ZecMiningResponse | null
  investedUSD: number | null
  pools: HoldingsResponse["miningPools"]
  loading: boolean
} {
  const { data: network } = useSWR<ZecMiningResponse>(
    "/api/zec-mining",
    swrFetcher,
    MINING_SWR
  )
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    MINING_SWR
  )
  const mining = holdings?.mining ?? null
  // "Today" and "days live" are partial-day figures; without a clock of their
  // own they would sit frozen until the next five-minute SWR refresh. Starts
  // at 0 so the first client render matches the server's.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  // Both feeds gate the estimate: without holdings there is no start date and
  // no disclosure to calibrate on, and a stated-fleet number that flips to a
  // disclosure-based one a second later reads as the page changing its mind.
  const estimate = useMemo(() => {
    if (!network || !holdings) return null
    return estimateCyphMining({
      network,
      startedAt: mining?.startedAt ?? null,
      disclosures: mining?.disclosures ?? [],
      now: Date.now(),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the clock
  }, [network, holdings, mining, tick])
  if (!network || !holdings) {
    return { estimate: null, network: null, investedUSD: null, pools: [], loading: true }
  }
  return {
    estimate,
    network,
    investedUSD: mining?.investedUSD ?? null,
    pools: holdings.miningPools ?? [],
    loading: false,
  }
}

function fmtZec(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

/** "AUG 18" from "2026-08-18". */
function fmtDay(day: string): string {
  const [, m, d] = day.split("-")
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`
}

/** "AUG 18 – 31, 2026", "AUG 18 – SEP 3, 2026" or "DEC 20, 2026 – JAN 5, 2027". */
export function fmtPeriod(from: string, to: string): string {
  const fromYear = from.slice(0, 4)
  const toYear = to.slice(0, 4)
  if (fromYear !== toYear) return `${fmtDay(from)}, ${fromYear} – ${fmtDay(to)}, ${toYear}`
  const sameMonth = from.slice(0, 7) === to.slice(0, 7)
  const end = sameMonth ? String(Number(to.slice(8, 10))) : fmtDay(to)
  return `${fmtDay(from)} – ${end}, ${toYear}`
}

function fmtGSol(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${value.toFixed(digits)} GSOL/S`
}

/* ── Treasury page MINING tab ────────────────────────────────────────── */

type MiningChart = "cumulative" | "daily" | "hashrate"

export function MiningTab({
  zecPrice,
  className,
}: {
  zecPrice: number | null
  className?: string
}) {
  const { estimate, network, investedUSD, pools, loading } = useCyphMining()
  const [chart, setChart] = useState<MiningChart>("cumulative")
  const isMobile = useIsMobile()
  const chartW = isMobile ? 360 : 900
  // Same key the treasury page already holds, so this is a cache read. Daily
  // ZEC closes price each mined day at the price it was mined, which is what
  // turns "mined value" into a gain figure rather than a mark.
  const { data: prices } = useSWR<PricesResponse>("/api/prices?days=all", swrFetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  const closeByDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of prices?.history ?? []) {
      if (Number.isFinite(h.zec) && h.zec > 0) {
        m.set(new Date(h.timestamp).toISOString().slice(0, 10), h.zec)
      }
    }
    return m
  }, [prices])
  const minedAt = useMemo(() => {
    if (!estimate) return null
    // Each day's ZEC at that day's close; a day with no close falls back to
    // the nearest earlier one, then is skipped.
    let valueUsd = 0
    let pricedZec = 0
    let lastClose: number | null = null
    for (const d of estimate.series) {
      const close: number | null = closeByDay.get(d.date) ?? lastClose
      if (close == null) continue
      lastClose = close
      valueUsd += d.zec * close
      pricedZec += d.zec
    }
    const avgPrice = pricedZec > 0 ? valueUsd / pricedZec : null
    const perDisclosure = estimate.disclosures.map((disc) => {
      let sum = 0
      let n = 0
      for (let ms = Date.parse(`${disc.from}T00:00:00Z`); ms <= Date.parse(`${disc.to}T00:00:00Z`); ms += 86_400_000) {
        const c = closeByDay.get(new Date(ms).toISOString().slice(0, 10))
        if (c != null) {
          sum += c
          n++
        }
      }
      return n > 0 ? sum / n : null
    })
    return { valueUsd, pricedZec, avgPrice, perDisclosure }
  }, [estimate, closeByDay])

  if (loading || !estimate) {
    return (
      <div className={className}>
        <CornerBox label="MINING" color={MINING}>
          <Skeleton className="mt-2" height={160} />
        </CornerBox>
      </div>
    )
  }
  if (estimate.startedAt == null) {
    return (
      <div className={className}>
        <CornerBox label="MINING" color={MINING}>
          <p className="py-8 text-center text-[11px]" style={{ opacity: 0.55 }}>
            Cypherpunk has not disclosed a mining outlay yet.
          </p>
        </CornerBox>
      </div>
    )
  }

  const total = estimate.totalZecToDate
  const totalUsd = total != null && zecPrice != null ? total * zecPrice : null
  const usdPerDay =
    estimate.estZecPerDay != null && zecPrice != null
      ? estimate.estZecPerDay * zecPrice
      : null
  // Gain on the mined stack: what it is worth now against what it was worth
  // the days it was mined, on the coins that have a close to price them.
  const gainPct =
    minedAt?.avgPrice != null && zecPrice != null && minedAt.avgPrice > 0
      ? (zecPrice / minedAt.avgPrice - 1) * 100
      : null
  const gainColor =
    gainPct == null ? paletteVar("text") : gainPct >= 0 ? paletteVar("cyph") : E_STATIC.red
  const recoupedPct =
    totalUsd != null && investedUSD != null && investedUSD > 0
      ? (totalUsd / investedUSD) * 100
      : null
  const paybackYears =
    usdPerDay != null && usdPerDay > 0 && investedUSD != null && totalUsd != null
      ? Math.max(0, investedUSD - totalUsd) / usdPerDay / 365
      : null
  const hashpriceUsd =
    estimate.zecPerGSolPerDay != null && zecPrice != null
      ? estimate.zecPerGSolPerDay * zecPrice
      : null
  const blocksPerDayEquiv =
    estimate.estZecPerDay != null && network?.minerRewardPerBlock
      ? estimate.estZecPerDay / network.minerRewardPerBlock
      : null
  const hasDisclosure = estimate.disclosures.length > 0
  const estFromDay =
    estimate.officialThrough != null
      ? new Date(Date.parse(`${estimate.officialThrough}T00:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : estimate.startedAt.slice(0, 10)

  // Pool ranking: where the implied share would sit among the listed pools.
  // The fleet almost certainly mines *through* one of them, so this is a size
  // comparison, not a claim that Cypherpunk is a distinct pool.
  const namedPools = pools.filter((p) => p.name.toLowerCase() !== "others")
  const poolRank =
    estimate.sharePct != null
      ? namedPools.filter((p) => p.share > estimate.sharePct!).length + 1
      : null
  // Plain computations, not memos: this sits below the loading returns and a
  // hook here would change the hook order between renders.
  const poolRows: { name: string; share: number; cyph: boolean }[] = pools.map((p) => ({
    name: p.name,
    share: p.share,
    cyph: false,
  }))
  if (estimate.sharePct != null) {
    poolRows.push({ name: "CYPHERPUNK (IMPLIED)", share: estimate.sharePct, cyph: true })
  }
  // "Others" stays last whatever its size; everything else by share.
  poolRows.sort((a, b) => {
    const ao = a.name.toLowerCase() === "others"
    const bo = b.name.toLowerCase() === "others"
    if (ao !== bo) return ao ? 1 : -1
    return b.share - a.share
  })
  const maxPoolShare = poolRows.reduce((m, p) => Math.max(m, p.share), 0)

  const hashrateSeries = (network?.history ?? [])
    .filter((d) => d.hashrateSolS != null)
    .slice(-90)
    .map((d) => ({ date: d.date, gsol: (d.hashrateSolS as number) / 1e9 }))

  return (
    <div className={className}>
      {/* ZEC MINED — the headline. Official figure first, then what we add on
          top of it and how. */}
      <CornerBox
        label={
          <span className="inline-flex items-center gap-1.5">
            <Pickaxe aria-hidden="true" size={12} />
            ZEC MINED
          </span>
        }
        color={MINING}
        className="mb-3"
        action={
          <span className="inline-flex items-center gap-1" style={{ color: MINING }}>
            {hasDisclosure ? "OFFICIAL + EST" : "EST"}
            <InfoTip color={MINING} label="How the mining figures work" size={13}>
              <p>Official figures are cypherpunk.com&rsquo;s, shown as published.</p>
              {estimate.basis === "disclosure" && estimate.calibratedOn ? (
                <p className="mt-2">
                  Implied fleet: {fmtZec(estimate.calibratedOn.zec, 2)} ZEC for{" "}
                  {fmtPeriod(estimate.calibratedOn.from, estimate.calibratedOn.to)} ÷ what
                  one Sol/s earned on those days (CipherScan blocks × {network?.minerRewardPerBlock} ZEC
                  ÷ hashrate) = {fmtGSol(estimate.impliedFleetGSolS)}. Site states {estimate.fleetGSolS}.
                </p>
              ) : (
                <p className="mt-2">
                  No disclosure to calibrate on; running on the {estimate.fleetGSolS} GSol/s
                  the site states ({estimate.fleetObservedAt}).
                </p>
              )}
              <p className="mt-2">
                Since {fmtDay(estFromDay)}: that fleet through each day&rsquo;s real network
                hashrate, plus a partial today. Assumes a constant fleet.
              </p>
            </InfoTip>
          </span>
        }
      >
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <div className="text-[10px] tracking-[0.16em]" style={{ opacity: 0.55 }}>
              MINED TO DATE
              {estimate.daysLive != null && ` · LIVE ${estimate.daysLive.toFixed(0)}D`}
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span
                className="text-3xl font-bold tabular-nums md:text-4xl"
                style={{ color: MINING, textShadow: `0 0 12px ${MINING}55` }}
              >
                {total != null ? `${fmtZec(total)} ZEC` : "—"}
              </span>
              {totalUsd != null && (
                <span className="text-[12px] tabular-nums" style={{ opacity: 0.7 }}>
                  ≈ {fmtCompactUSD(totalUsd)}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 text-[11px] tabular-nums">
            <div>
              <div className="text-[9px] tracking-[0.14em]" style={{ opacity: 0.5 }}>
                OFFICIAL
              </div>
              <div className="font-bold" style={{ color: MINING }}>
                {hasDisclosure ? `${fmtZec(estimate.officialZec, 2)} ZEC` : "—"}
              </div>
              <div className="text-[9px]" style={{ opacity: 0.5 }}>
                {estimate.officialThrough
                  ? `THROUGH ${fmtDay(estimate.officialThrough)}`
                  : "NOT YET PUBLISHED"}
              </div>
            </div>
            <div>
              <div className="text-[9px] tracking-[0.14em]" style={{ opacity: 0.5 }}>
                EST. SINCE
              </div>
              <div className="font-bold" style={{ color: paletteVar("text") }}>
                {estimate.estZecSinceOfficial != null
                  ? `+${fmtZec(estimate.estZecSinceOfficial)} ZEC`
                  : "—"}
              </div>
              <div className="text-[9px]" style={{ opacity: 0.5 }}>
                {estimate.estZecSinceOfficial == null
                  ? "NETWORK DATA UNAVAILABLE"
                  : estimate.estDaysSinceOfficial != null
                    ? `${fmtDay(estFromDay)} → NOW · ${estimate.estDaysSinceOfficial.toFixed(1)}D`
                    : ""}
              </div>
            </div>
          </div>
        </div>

        <div
          className="mt-3 grid grid-cols-2 gap-px border md:grid-cols-4"
          style={{ borderColor: `${MINING}33` }}
        >
          <MiningCell label="EST. ZEC / DAY" value={fmtZec(estimate.estZecPerDay, 1)} color={MINING} />
          <MiningCell label="EST. TODAY" value={fmtZec(estimate.estZecToday, 1)} />
          <MiningCell
            label={estimate.basis === "disclosure" ? "IMPLIED FLEET" : "STATED FLEET"}
            value={fmtGSol(estimate.effectiveFleetGSolS)}
            sub={
              estimate.basis === "disclosure"
                ? `SITE SAYS ${estimate.fleetGSolS}`
                : `SITE · ${estimate.fleetObservedAt}`
            }
          />
          <MiningCell
            label="NETWORK SHARE"
            value={estimate.sharePct != null ? `${estimate.sharePct.toFixed(2)}%` : "—"}
            color={paletteVar("cyph")}
            sub={poolRank != null && namedPools.length ? `#${poolRank} IF A POOL` : undefined}
          />
        </div>
      </CornerBox>

      <div
        className="grid gap-3 mb-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
      >
        {/* OFFICIAL DISCLOSURES — exact dates, average, total. */}
        <CornerBox
          label="OFFICIAL DISCLOSURES"
          color={MINING}
          action={
            <a
              href="https://www.cypherpunk.com/#mining"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] tracking-[0.2em] hover:underline"
              style={{ color: MINING }}
            >
              CYPHERPUNK.COM →
            </a>
          }
        >
          {!hasDisclosure ? (
            <p className="py-6 text-center text-[11px]" style={{ opacity: 0.55 }}>
              No ZEC-mined figure published yet.
            </p>
          ) : (
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-[11px] tabular-nums">
                <thead>
                  <tr className="text-[9px] tracking-[0.14em] whitespace-nowrap" style={{ opacity: 0.5 }}>
                    <th className="py-1 text-left font-normal">PERIOD</th>
                    <th className="py-1 pl-2 text-right font-normal">ZEC</th>
                    <th className="py-1 pl-2 text-right font-normal">/DAY</th>
                    <th className="py-1 pl-2 text-right font-normal">MINED @</th>
                    <th className="py-1 pl-2 text-right font-normal">GAIN</th>
                  </tr>
                </thead>
                <tbody>
                  {estimate.disclosures.map((d, i) => {
                    const at = minedAt?.perDisclosure[i] ?? null
                    const g = at != null && zecPrice != null ? (zecPrice / at - 1) * 100 : null
                    return (
                      <tr
                        key={`${d.from}-${d.to}`}
                        style={{ borderTop: `1px dotted ${paletteVar("text")}22` }}
                      >
                        <td className="py-1.5 whitespace-nowrap">
                          {fmtPeriod(d.from, d.to)}
                          <span className="ml-1 text-[9px]" style={{ opacity: 0.5 }}>{d.days}D</span>
                        </td>
                        <td className="py-1.5 pl-2 text-right font-bold" style={{ color: MINING }}>
                          {fmtZec(d.zec, 2)}
                        </td>
                        <td className="py-1.5 pl-2 text-right">{fmtZec(d.zec / d.days, 1)}</td>
                        <td className="py-1.5 pl-2 text-right">{at != null ? `$${at.toFixed(0)}` : "—"}</td>
                        <td
                          className="py-1.5 pl-2 text-right font-bold"
                          style={{ color: g == null ? paletteVar("text") : g >= 0 ? paletteVar("cyph") : E_STATIC.red }}
                        >
                          {g != null ? `${g >= 0 ? "+" : ""}${g.toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    )
                  })}
                  {estimate.disclosures.length > 1 && (
                    <tr className="font-bold" style={{ borderTop: `1px solid ${MINING}55` }}>
                      <td className="py-1.5">TOTAL</td>
                      <td className="py-1.5 pl-2 text-right" style={{ color: MINING }}>
                        {fmtZec(estimate.officialZec, 2)}
                      </td>
                      <td className="py-1.5 pl-2 text-right">{fmtZec(estimate.officialZecPerDay, 1)}</td>
                      <td className="py-1.5 pl-2 text-right" />
                      <td className="py-1.5 pl-2 text-right" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CornerBox>

        {/* ECONOMICS — capex against what the coins are worth. */}
        <CornerBox label="MINING ECONOMICS" color={MINING}>
          <div
            className="mt-1 grid grid-cols-2 gap-px border"
            style={{ borderColor: `${MINING}33` }}
          >
            <MiningCell label="DEPLOYED" value={fmtCompactUSD(investedUSD)} sub={`SINCE ${fmtDay(estimate.startedAt.slice(0, 10))}`} />
            <MiningCell label="MINED VALUE" value={fmtCompactUSD(totalUsd)} color={MINING} sub="AT LIVE ZEC" />
            <MiningCell
              label="MINED @ AVG"
              value={minedAt?.avgPrice != null ? `$${minedAt.avgPrice.toFixed(0)}` : "—"}
              sub={minedAt?.valueUsd ? `${fmtCompactUSD(minedAt.valueUsd)} WHEN MINED` : undefined}
            />
            <MiningCell
              label="GAIN SINCE"
              value={gainPct != null ? `${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%` : "—"}
              color={gainColor}
              sub={
                minedAt?.valueUsd && totalUsd != null
                  ? `${totalUsd - minedAt.valueUsd >= 0 ? "+" : "−"}${fmtCompactUSD(Math.abs(totalUsd - minedAt.valueUsd))}`
                  : undefined
              }
            />
            <MiningCell
              label="RECOUPED"
              value={recoupedPct != null ? `${recoupedPct.toFixed(1)}%` : "—"}
              color={paletteVar("cyph")}
              sub="OF DEPLOYED"
            />
            <MiningCell
              label="PAYBACK"
              value={paybackYears != null ? `${paybackYears.toFixed(1)} YRS` : "—"}
              sub="AT CURRENT RATE"
            />
            <MiningCell label="EST. USD / DAY" value={fmtCompactUSD(usdPerDay)} />
            <MiningCell
              label="HASHPRICE"
              value={hashpriceUsd != null ? `$${Math.round(hashpriceUsd).toLocaleString("en-US")}` : "—"}
              sub="USD / GSOL / DAY"
            />
          </div>
        </CornerBox>

        {/* NETWORK — what the fleet is up against. */}
        <CornerBox label="ZEC NETWORK" color={paletteVar("zec")}>
          <div
            className="mt-1 grid grid-cols-2 gap-px border"
            style={{ borderColor: withAlpha(paletteVar("zec"), 20) }}
          >
            <MiningCell label="HASHRATE" value={fmtGSol(estimate.networkGSolS)} color={paletteVar("zec")} />
            <MiningCell label="DIFFICULTY" value={fmtCompactNumber(network?.difficulty)} />
            <MiningCell label="BLOCKS 24H" value={fmtZec(network?.blocks24h)} sub={network?.avgBlockTimeSecs ? `${network.avgBlockTimeSecs}S AVG` : undefined} />
            <MiningCell label="TO MINERS / DAY" value={`${fmtZec(network?.dailyMinerRevenueZec)} ZEC`} sub={network?.minerRewardPerBlock ? `${network.minerRewardPerBlock} ZEC / BLOCK` : undefined} />
            <MiningCell label="ZEC / GSOL / DAY" value={fmtZec(estimate.zecPerGSolPerDay, 1)} />
            <MiningCell
              label="FLEET ≈ BLOCKS / DAY"
              value={blocksPerDayEquiv != null ? blocksPerDayEquiv.toFixed(0) : "—"}
              sub={blocksPerDayEquiv != null ? `ONE EVERY ${(1440 / blocksPerDayEquiv).toFixed(0)} MIN` : undefined}
            />
          </div>
        </CornerBox>

        {/* POOL SHARE — the implied fleet next to the public pools. */}
        {poolRows.length > 1 && (
          <CornerBox
            label="VS MINING POOLS"
            color={MINING}
            action={
              <InfoTip color={MINING} label="About the pool comparison" size={13}>
                <p>
                  Pool shares per cypherpunk.com. Cypherpunk&rsquo;s row is our implied
                  share; the fleet likely mines through one of these pools, so this is a
                  size comparison, not a separate slice.
                </p>
              </InfoTip>
            }
          >
            <div className="mt-1 flex flex-col gap-1.5">
              {poolRows.map((p) => {
                const w = maxPoolShare > 0 ? (p.share / maxPoolShare) * 100 : 0
                const c = p.cyph ? MINING : paletteVar("zec")
                return (
                  <div key={p.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="truncate tracking-[0.08em]"
                        style={{ color: p.cyph ? MINING : paletteVar("text"), opacity: p.cyph ? 1 : 0.75, fontWeight: p.cyph ? 700 : 400 }}
                      >
                        {p.name.toUpperCase()}
                      </span>
                    </div>
                    <span className="tabular-nums font-bold" style={{ color: c }}>
                      {p.share.toFixed(1)}%
                    </span>
                    <div className="col-span-2 h-[3px]" style={{ background: withAlpha(paletteVar("text"), 8) }}>
                      <div className="h-full" style={{ width: `${w}%`, background: c, opacity: p.cyph ? 1 : 0.55 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CornerBox>
        )}
      </div>

      {/* CHARTS — production and the network it depends on. */}
      <CornerBox
        label="MINING CHARTS"
        color={MINING}
        className="mb-3"
        action={
          <span
            className="flex items-center gap-px border-b"
            style={{ borderColor: `${paletteVar("text")}33` }}
          >
            {(
              [
                ["cumulative", "MINED TO DATE"],
                ["daily", "ZEC / DAY"],
                ["hashrate", "NETWORK · 90D"],
              ] as const
            ).map(([v, l]) => {
              const on = chart === v
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setChart(v)}
                  aria-pressed={on}
                  className="relative px-2 py-1 text-[11px] tracking-[0.1em] font-bold transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                  style={{
                    color: on ? MINING : paletteVar("text"),
                    opacity: on ? 1 : 0.7,
                    textShadow: on ? `0 0 6px ${MINING}55` : "none",
                    outlineColor: MINING,
                  }}
                >
                  {l}
                  {on && (
                    <span
                      aria-hidden="true"
                      className="absolute left-1 right-1 -bottom-px h-[1px]"
                      style={{ background: MINING, boxShadow: `0 0 4px ${MINING}` }}
                    />
                  )}
                </button>
              )
            })}
          </span>
        }
      >
        {chart === "cumulative" && estimate.series.length >= 2 && (
          <>
            <SimpleLineChartE
              data={estimate.series}
              accessor={(d) => d.cumulative}
              color={MINING}
              height={220}
              format={(v) => fmtCompactNumber(v)}
              label="ZEC"
              viewBoxWidth={chartW}
            />
            <ChartNote>
              {hasDisclosure
                ? `Official through ${fmtDay(estimate.officialThrough!)} (spread evenly), estimated after.`
                : "Estimated throughout."}
            </ChartNote>
          </>
        )}
        {chart === "daily" && estimate.series.length >= 2 && (
          <>
            <SimpleLineChartE
              data={estimate.series.filter((d) => d.date < estimate.series[estimate.series.length - 1].date)}
              accessor={(d) => d.zec}
              color={MINING}
              height={220}
              format={(v) => v.toFixed(0)}
              label="ZEC/D"
              viewBoxWidth={chartW}
            />
            <ChartNote>
              Official periods at their average; estimated days move with network hashrate. Today excluded.
            </ChartNote>
          </>
        )}
        {chart === "hashrate" && (
          hashrateSeries.length >= 2 ? (
            <>
              <SimpleLineChartE
                data={hashrateSeries}
                accessor={(d) => d.gsol}
                color={paletteVar("zec")}
                height={220}
                format={(v) => `${v.toFixed(1)}G`}
                label="GSOL/S"
                viewBoxWidth={chartW}
              />
              <ChartNote>Daily average network hashrate. A flat fleet earns less as this rises.</ChartNote>
            </>
          ) : (
            <div className="py-12 text-center text-[11px]" style={{ opacity: 0.5 }}>
              Network history unavailable.
            </div>
          )
        )}
      </CornerBox>

      <p className="text-[11px]" style={{ color: paletteVar("text"), opacity: 0.4 }}>
        Disclosures and pools:{" "}
        <a href="https://www.cypherpunk.com/#mining" target="_blank" rel="noopener noreferrer" className="hover:underline">
          cypherpunk.com
        </a>
        . Network data:{" "}
        <a href="https://cipherscan.app/network" target="_blank" rel="noopener noreferrer" className="hover:underline">
          CipherScan
        </a>
        . EST figures are ours.
      </p>
    </div>
  )
}

function ChartNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] mt-2" style={{ color: paletteVar("text"), opacity: 0.7 }}>
      {children}
    </div>
  )
}

function MiningCell({
  label,
  value,
  color,
  sub,
}: {
  label: string
  value: string
  color?: string
  sub?: string
}) {
  return (
    <div className="min-w-0 px-2 py-2">
      <div className="truncate text-[8px] tracking-[0.14em]" style={{ opacity: 0.5 }}>
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[12px] font-bold tabular-nums"
        style={{ color: color ?? paletteVar("text") }}
        title={value}
      >
        {value}
      </div>
      {sub && (
        <div className="truncate text-[8px] tracking-[0.1em] tabular-nums" style={{ opacity: 0.45 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

/* ── Dashboard CYPH tile chip ────────────────────────────────────────── */

/** Mining run-rate for the CYPH tile header, sharing the TILE_CHIP geometry
 *  used by the OPEN / #rank / LIVE chips so the header row stays one line.
 *
 *  `~` carries the estimate caveat that the treasury's MINING tab spells out
 *  in full — the header has room for a number, not a disclaimer. Renders
 *  nothing until a mining outlay is disclosed. */
export function MiningChip() {
  const { estimate, loading } = useCyphMining()
  if (loading || !estimate || estimate.startedAt == null) return null
  const perDay = estimate.estZecPerDay
  if (perDay == null) return null

  return (
    <Link
      href="/holdings?view=mining"
      className="group box-border inline-flex h-[18px] min-h-[18px] max-h-[18px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0 text-[9px] font-bold leading-none tracking-[0.1em] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{
        borderColor: `${MINING}55`,
        color: MINING,
        outlineColor: MINING,
      }}
      title={`Cypherpunk Mining — estimated ${fmtZec(perDay, 0)} ZEC/day from a ${estimate.effectiveFleetGSolS.toFixed(1)} GSol/s ${estimate.basis === "disclosure" ? "implied" : "stated"} fleet`}
    >
      <Pickaxe aria-hidden="true" size={9} />
      <span className="tabular-nums">~{fmtZec(perDay, 0)}</span>
      <span style={{ color: paletteVar("text"), opacity: 0.7 }}>ZEC/D</span>
    </Link>
  )
}
