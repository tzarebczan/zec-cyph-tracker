"use client"

import { useMemo } from "react"
import Link from "next/link"
import useSWR from "swr"
import {
  CoinLogo,
  CornerBox,
  LED,
  BlockProgress,
  PhosphorSpark,
  LiveNumber,
  PerfGrid,
  MultiLineChartE,
} from "./primitives"
import { BetaPipPopout, BetaPwaInstall } from "./footer-buttons"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import type {
  PricesResponse,
  QuoteSnapshot,
  MarketsResponse,
  ZecStatsResponse,
  HoldingsResponse,
} from "./api-types"

// Period labels follow finance-pricing convention: weeks/months/years
// rather than raw days so a 30-day chart reads as "1M". The query-param
// value (left side of the tuple) stays in days because that's what
// /api/prices already accepts. Exported so /beta/page.tsx can render
// the period selector in EShell's headerExtra slot.
export const PERIODS = [
  ["1", "1D"],
  ["7", "1W"],
  ["14", "2W"],
  ["30", "1M"],
  ["90", "3M"],
  ["180", "6M"],
  ["all", "ALL"],
] as const

export type Period = (typeof PERIODS)[number][0]
const VALID_PERIODS = new Set(PERIODS.map(([v]) => v))
export function isValidPeriod(v: unknown): v is Period {
  return typeof v === "string" && VALID_PERIODS.has(v as Period)
}

const POOL_COLORS = {
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

// Tiny terminal-style icons. Inline SVG (rather than emoji) renders
// identically across iOS/Android/desktop and inherits `currentColor`
// so they tint with whatever palette / active state the parent uses.
// All share a 16-unit viewBox so the `size` prop produces predictable
// pixel dimensions in any context.

function ShieldIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <path d="M8 1L2 3v4.5c0 3.5 2.4 6.6 6 7.5 3.6-.9 6-4 6-7.5V3L8 1zm0 2.1l4 1.3v3.1c0 2.6-1.7 4.9-4 5.6-2.3-.7-4-3-4-5.6V4.4l4-1.3z" />
    </svg>
  )
}

/** Stacked bars — used for VOLUME metric cells. */
function BarsIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <rect x="1" y="9" width="3" height="6" />
      <rect x="6.5" y="5" width="3" height="10" />
      <rect x="12" y="1" width="3" height="14" />
    </svg>
  )
}

/** Activity line — used for TRANSACTIONS metric cells. */
function ActivityIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      strokeLinejoin="miter"
      className="shrink-0 inline-block"
    >
      <path d="M1 9 L4 9 L6 4 L9 12 L11 7 L15 7" />
    </svg>
  )
}

/** Pickaxe-ish wedge — used for MINED progress cells. */
function MinedIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 0 1 5 5h-5V3z" />
    </svg>
  )
}

/** Vault — used for TREASURY metric cells. */
function VaultIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="shrink-0 inline-block"
    >
      <rect x="1.5" y="2.5" width="13" height="11" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 5.5v2M8 8.5v2M5.5 8h2M8.5 8h2" />
    </svg>
  )
}

/** Coin / dollar — used for NAV/SHARE cells. */
function CoinIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="shrink-0 inline-block"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4v8M6 6h3.5a1.5 1.5 0 0 1 0 3H7a1.5 1.5 0 0 0 0 3h3.5" strokeLinecap="square" />
    </svg>
  )
}

/** Up/down arrow — used for PREMIUM/DISCOUNT cells. */
function TrendIcon({ size = 10, down = false }: { size?: number; down?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      strokeLinejoin="miter"
      className="shrink-0 inline-block"
      style={{ transform: down ? "scaleY(-1)" : undefined }}
    >
      <path d="M1 12 L6 7 L9 10 L15 4" />
      <path d="M11 4 L15 4 L15 8" />
    </svg>
  )
}

export function BetaDashboard({ period }: { period: Period }) {
  // The period selector lives in EShell's `headerExtra` slot
  // (rendered from /beta/page.tsx); BetaDashboard just consumes the
  // current value to drive the /api/prices fetch.
  // Reuse the same SWR keys as the legacy dashboard so both surfaces
  // share a single network round-trip per refresh window.
  const { data: prices } = useSWR<PricesResponse>(
    `/api/prices?days=${period}`,
    swrFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  // Always-on tick subscription so the headline ZEC price ticks even
  // when the user has the chart on a longer period.
  const { data: tick } = useSWR<PricesResponse>(
    "/api/prices?days=7",
    swrFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 5 * 60_000,
    keepPreviousData: true,
  })
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  // Treasury — slow-moving (purchases are weeks apart) so a 5-min
  // refresh and the API's own KV-cached 6h edge TTL are plenty.
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  // Daily ZEC tx counts — used in the ZEC tile's at-a-glance row.
  // Same SWR key as the stats page so the two surfaces share a
  // single network fetch per refresh window.
  const { data: txStats } = useSWR<{
    days: { date: string; total: number }[]
  }>("/api/zec-tx-stats", swrFetcher, {
    refreshInterval: 30 * 60_000,
    keepPreviousData: true,
  })
  const dailyZecTx = useMemo(() => {
    const days = txStats?.days ?? []
    return days.length > 0 ? days[days.length - 1].total : null
  }, [txStats])

  const cyphPrice = pickLiveCyph(quote)
  const zecPrice =
    tick?.current?.zec?.price ?? prices?.current?.zec?.price ?? null
  const ratio =
    cyphPrice != null && zecPrice != null && zecPrice > 0
      ? cyphPrice / zecPrice
      : null

  const history = prices?.history ?? []
  const stats = prices?.stats

  // 24H dollar change for the CYPH and ZEC headline tiles. The new
  // design adds a "+$0.00 today" row under the headline so the tile
  // surfaces the absolute move alongside the % change in the badge.
  const cyphChange24h = stats?.cyph.change24h ?? null
  const zecChange24h = stats?.zec.change24h ?? null
  const cyphDollarChange =
    cyphPrice != null && cyphChange24h != null
      ? (cyphPrice * cyphChange24h) / (100 + cyphChange24h)
      : null
  const zecDollarChange =
    zecPrice != null && zecChange24h != null
      ? (zecPrice * zecChange24h) / (100 + zecChange24h)
      : null

  // Ratio averages from the prices stats block, with `vsAvg` recomputed
  // off the live ratio so the chips agree with the headline number.
  const ratioStats = useMemo(() => {
    const avg24h = stats?.ratio.avg24h ?? null
    const avg7d = stats?.ratio.avg7d ?? null
    const avg30d = stats?.ratio.avg30d ?? null
    const vs = (avg: number | null) =>
      avg != null && avg > 0 && ratio != null ? ((ratio - avg) / avg) * 100 : null
    return {
      avg24h,
      avg7d,
      avg30d,
      vs24h: vs(avg24h),
      vs7d: vs(avg7d),
      vs30d: vs(avg30d),
    }
  }, [stats, ratio])

  // Sparkline sources — last ~30 daily closes from history.
  const cyphSpark = history.map((h) => h.cyph)
  const zecSpark = history.map((h) => h.zec)
  const ratioSpark = history.flatMap((h) =>
    h.ratio != null ? [h.ratio] : []
  )

  // Rank chip → ZEC's neighbours on the leaderboard for the supply
  // panel "RANK NEIGHBORS" widget.
  const zecRank = zecStats?.rank ?? null
  const rankNeighbors = useMemo(() => {
    const coins = markets?.coins ?? []
    if (zecRank == null || coins.length === 0) return []
    return coins.filter((c) => Math.abs(c.rank - zecRank) <= 2)
  }, [markets, zecRank])
  const nextCoin = useMemo(() => {
    if (zecRank == null || !markets) return null
    return markets.coins.find((c) => c.rank === zecRank - 1) ?? null
  }, [markets, zecRank])
  const deltaToNextPrice =
    nextCoin?.marketCap != null &&
    zecStats?.marketCap != null &&
    zecStats?.circulating != null &&
    zecStats.circulating > 0
      ? (nextCoin.marketCap - zecStats.marketCap) / zecStats.circulating
      : null

  // Treasury-derived NAV (intrinsic value per CYPH share). Replaces
  // the hard-coded 240_000 from the redesign mockup with the real
  // total-ZEC-held figure from /api/cypherpunk-holdings.
  const totalZec = holdings?.summary.totalZec ?? null
  const sharesOutstanding = quote?.sharesOutstanding ?? null
  const navPerShare =
    totalZec != null && zecPrice != null && sharesOutstanding && sharesOutstanding > 0
      ? (totalZec * zecPrice) / sharesOutstanding
      : null
  const treasuryUsd =
    totalZec != null && zecPrice != null ? totalZec * zecPrice : null
  const premiumPct =
    cyphPrice != null && navPerShare != null && navPerShare > 0
      ? ((cyphPrice - navPerShare) / navPerShare) * 100
      : null

  const shielded = zecStats?.shieldedBreakdown ?? null
  const shieldedPct =
    zecStats?.shieldedPct ?? shielded?.pct ?? null
  const circulating = zecStats?.circulating ?? null

  // CYPH market-state → badge text. REGULAR shows OPEN; pre/after/
  // overnight surface their own labels so the badge reads like the
  // CMS-style status pill the new design wants.
  const cyphMarketBadge =
    quote?.marketState === "REGULAR"
      ? "OPEN"
      : quote?.marketState === "PRE"
        ? "PRE"
        : quote?.marketState === "POST"
          ? "AFT"
          : quote?.marketState === "POSTPOST"
            ? "OVN"
            : quote?.marketState === "CLOSED"
              ? "CLOSED"
              : quote?.marketState ?? "—"

  return (
    <>
      {/* Period selector lives in EShell's headerExtra slot (rendered
          from /beta/page.tsx). The "N candles" caption was removed at
          the user's request — it ate a row of vertical space on
          desktop without adding actionable info. */}

      {/* THREE READOUTS — CYPH / ZEC / RATIO. Each is clickable in the
          new design: CYPH → /holdings, ZEC → /stats, RATIO → /estimator.
          We wrap each CornerBox in a Link so middle-click / cmd-click
          opens in a new tab; the CornerBox's `interactive` prop powers
          the hover glow + corner-glyph brighten. Tile gap shrinks on
          mobile so three stacked cards take less vertical space. */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3 mb-2 md:mb-3">
        {/* CYPH */}
        <Link href="/beta/holdings" className="block group h-full">
          <CornerBox color={paletteVar("cyph")} interactive className="flex flex-col h-full">
            <div className="flex items-baseline justify-between">
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[11px] tracking-[0.3em] font-bold"
                  style={{
                    color: paletteVar("cyph"),
                    textShadow: `0 0 6px ${paletteVar("cyph")}55`,
                  }}
                >
                  CYPH
                </span>
                <span
                  className="text-[8px] px-1 py-0.5 border"
                  style={{
                    borderColor: `${paletteVar("cyph")}55`,
                    color: paletteVar("cyph"),
                  }}
                >
                  {cyphMarketBadge}
                </span>
              </div>
              <PerfBadge value={stats?.cyph.change24h} label="24H" />
            </div>
            {/* Price block — fixed min-height across all three tiles
                so the sparkline below lands on the same Y position
                even when the dollar-change line is hidden (RATIO
                tile, CYPH on a flat day, etc.) */}
            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={cyphPrice}
                  format={(v) => "$" + v.toFixed(2)}
                  color={paletteVar("cyph")}
                />
              </div>
              {cyphDollarChange != null &&
                cyphChange24h != null &&
                // Hide the "$0.00 today" line when the movement is
                // effectively flat — otherwise a 0% close-to-close
                // reads as either a slightly positive or slightly
                // negative print and confuses the eye.
                Math.abs(cyphChange24h) >= 0.005 && (
                  <div
                    className="text-[10px] tabular-nums mt-0.5"
                    style={{
                      color:
                        cyphChange24h >= 0
                          ? paletteVar("cyph")
                          : E_STATIC.red,
                    }}
                  >
                    {cyphChange24h >= 0 ? "+" : "-"}$
                    {Math.abs(cyphDollarChange).toFixed(2)} today
                  </div>
                )}
            </div>
            {/* Sparkline lives in a min-height wrapper so the
                at-a-glance row below sits at the same Y as the ZEC
                tile even when the price series is still loading. */}
            <div className="mt-3 min-h-[2rem]">
              {cyphSpark.length >= 2 && (
                <PhosphorSpark
                  values={cyphSpark}
                  color={paletteVar("cyph")}
                  width={300}
                  height={32}
                />
              )}
            </div>
            {/* Treasury NAV at-a-glance row — sits between the sparkline
                and the perf grid so the user sees the treasury-derived
                metrics in the same vertical position as the ZEC tile's
                TX/VOL/MINED row + the RATIO tile's avg row. Only
                renders when both ZEC treasury + shares-out + ZEC price
                are present (and the treasury actually holds ZEC) so we
                never show "$0.00 NAV/SHARE" implying an empty
                treasury. */}
            {navPerShare != null &&
              treasuryUsd != null &&
              totalZec != null &&
              totalZec > 0 && (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("amber")}33` }}
              >
                <NavCell
                  label="NAV/SHARE"
                  value={navPerShare}
                  format={(v) => "$" + v.toFixed(2)}
                  color={paletteVar("amber")}
                  icon={<CoinIcon />}
                />
                <NavCell
                  label="TREASURY"
                  value={treasuryUsd}
                  format={fmtCompactUSD}
                  color={paletteVar("amber")}
                  icon={<VaultIcon />}
                />
                <div
                  className="px-2 py-1.5 text-center"
                  style={{
                    background:
                      premiumPct != null
                        ? ((premiumPct >= 0 ? paletteVar("cyph") : E_STATIC.red) + "0c")
                        : "transparent",
                  }}
                >
                  <div
                    className="text-[9px] tracking-wider inline-flex items-center gap-1"
                    style={{ color: paletteVar("text"), opacity: 0.6 }}
                  >
                    <TrendIcon down={premiumPct != null && premiumPct < 0} />
                    {premiumPct != null && premiumPct >= 0 ? "PREMIUM" : "DISCOUNT"}
                  </div>
                  <div
                    className="text-[14px] font-bold tabular-nums leading-tight"
                    style={{
                      color:
                        premiumPct != null && premiumPct >= 0
                          ? paletteVar("cyph")
                          : E_STATIC.red,
                    }}
                  >
                    {premiumPct != null
                      ? `${premiumPct >= 0 ? "+" : ""}${premiumPct.toFixed(1)}%`
                      : "—"}
                  </div>
                </div>
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={stats?.cyph.change24h ?? null}
                p7={stats?.cyph.change7d ?? null}
                p30={stats?.cyph.change30d ?? null}
                p90={stats?.cyph.change90d ?? null}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[10px]">
              {/* Session prices. The cell whose price equals the live
                  headline number gets a subtle highlight + dot so it's
                  obvious which extended-hours session is sourcing the
                  big number above. OVN (Blue Ocean overnight, 8 PM-4 AM
                  ET) only renders when an overnight tick was reported;
                  Yahoo drops the field outside the session window. */}
              <MetaRow
                label="PRE"
                value={
                  quote?.preMarketPrice != null
                    ? "$" + quote.preMarketPrice.toFixed(2)
                    : "—"
                }
                active={
                  cyphPrice != null &&
                  quote?.preMarketPrice != null &&
                  Math.abs(cyphPrice - quote.preMarketPrice) < 0.005
                }
                activeColor={paletteVar("cyph")}
              />
              <MetaRow
                label="AFT"
                value={
                  quote?.postMarketPrice != null
                    ? "$" + quote.postMarketPrice.toFixed(2)
                    : "—"
                }
                active={
                  cyphPrice != null &&
                  quote?.postMarketPrice != null &&
                  Math.abs(cyphPrice - quote.postMarketPrice) < 0.005
                }
                activeColor={paletteVar("cyph")}
              />
              {quote?.overnightMarketPrice != null && (
                <MetaRow
                  label="OVN"
                  value={"$" + quote.overnightMarketPrice.toFixed(2)}
                  active={
                    cyphPrice != null &&
                    Math.abs(cyphPrice - quote.overnightMarketPrice) < 0.005
                  }
                  activeColor={paletteVar("cyph")}
                />
              )}
              {/* Last regular-session close — shown only when the market
                  is not currently open so users have a clean reference
                  for the most recent "official" print regardless of
                  whether the headline above is PRE / AFT / OVN. */}
              {quote?.marketState !== "REGULAR" &&
                quote?.regularMarketPrice != null && (
                  <MetaRow
                    label="CLOSE"
                    value={"$" + quote.regularMarketPrice.toFixed(2)}
                  />
                )}
              <MetaRow label="MCAP" value={fmtCompactUSD(quote?.marketCap ?? null)} />
              <MetaRow
                label="SHARES"
                value={
                  sharesOutstanding != null
                    ? fmtCompactNumberLocal(sharesOutstanding)
                    : "—"
                }
              />
            </div>
          </CornerBox>
        </Link>

        {/* ZEC */}
        <Link href="/beta/stats" className="block group h-full">
          <CornerBox color={paletteVar("zec")} interactive className="flex flex-col h-full">
            <div className="flex items-baseline justify-between">
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[11px] tracking-[0.3em] font-bold"
                  style={{
                    color: paletteVar("zec"),
                    textShadow: `0 0 6px ${paletteVar("zec")}55`,
                  }}
                >
                  ZEC
                </span>
                {zecRank != null && (
                  <span
                    className="text-[8px] px-1 py-0.5 border"
                    style={{
                      borderColor: `${paletteVar("zec")}55`,
                      color: paletteVar("zec"),
                    }}
                  >
                    #{zecRank}
                  </span>
                )}
              </div>
              <PerfBadge value={stats?.zec.change24h} label="24H" />
            </div>
            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={zecPrice}
                  format={(v) => "$" + v.toFixed(2)}
                  color={paletteVar("zec")}
                />
              </div>
              {zecDollarChange != null &&
                zecChange24h != null &&
                Math.abs(zecChange24h) >= 0.005 && (
                  <div
                    className="text-[10px] tabular-nums mt-0.5"
                    style={{
                      color:
                        zecChange24h >= 0
                          ? paletteVar("cyph")
                          : E_STATIC.red,
                    }}
                  >
                    {zecChange24h >= 0 ? "+" : "-"}$
                    {Math.abs(zecDollarChange).toFixed(2)} today
                  </div>
                )}
            </div>
            <div className="mt-3 min-h-[2rem]">
              {zecSpark.length >= 2 && (
                <PhosphorSpark
                  values={zecSpark}
                  color={paletteVar("zec")}
                  width={300}
                  height={32}
                />
              )}
            </div>
            {/* ZEC at-a-glance row — sits in the same vertical
                position as the CYPH tile's NAV row so the two tiles
                read as a parallel grid (DAILY TX / VOL 24H / MINED %
                here mirrors NAV/SHARE / TREASURY / DISCOUNT there). */}
            {(dailyZecTx != null ||
              zecStats?.volume24h != null ||
              circulating != null) && (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("zec")}33` }}
              >
                <NavCell
                  label="DAILY TX"
                  value={dailyZecTx ?? 0}
                  format={(v) =>
                    v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toLocaleString()
                  }
                  color={paletteVar("zec")}
                  icon={<ActivityIcon />}
                />
                <NavCell
                  label="VOL 24H"
                  value={zecStats?.volume24h ?? 0}
                  format={fmtCompactUSD}
                  color={paletteVar("zec")}
                  icon={<BarsIcon />}
                />
                <NavCell
                  label="MINED"
                  value={circulating != null ? (circulating / 21e6) * 100 : 0}
                  format={(v) => v.toFixed(2) + "%"}
                  color={paletteVar("zec")}
                  icon={<MinedIcon />}
                />
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={stats?.zec.change24h ?? null}
                p7={stats?.zec.change7d ?? null}
                p30={stats?.zec.change30d ?? null}
                p90={stats?.zec.change90d ?? null}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[10px]">
              <MetaRow
                label="MCAP"
                value={fmtCompactUSD(zecStats?.marketCap ?? null)}
              />
              <MetaRow
                label="FLIP"
                value={
                  nextCoin && deltaToNextPrice != null
                    ? `${nextCoin.symbol} +$${deltaToNextPrice.toFixed(0)}`
                    : "—"
                }
              />
              <MetaRow
                label={
                  <span className="inline-flex items-center gap-1">
                    <ShieldIcon />
                    SHIELDED
                  </span>
                }
                value={shieldedPct != null ? `${shieldedPct.toFixed(1)}%` : "—"}
              />
              <MetaRow label="SUPPLY" value={circulating != null ? (circulating / 1e6).toFixed(2) + "M" : "—"} />
            </div>
          </CornerBox>
        </Link>

        {/* RATIO */}
        <Link href="/beta/estimator" className="block group h-full">
          <CornerBox color={paletteVar("ratio")} interactive className="flex flex-col h-full">
            <div className="flex items-baseline justify-between">
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[11px] tracking-[0.3em] font-bold"
                  style={{
                    color: paletteVar("ratio"),
                    textShadow: `0 0 6px ${paletteVar("ratio")}55`,
                  }}
                >
                  CYPH/ZEC
                </span>
                <span
                  className="text-[8px] px-1 py-0.5 border inline-flex items-center gap-1"
                  style={{
                    borderColor: `${paletteVar("ratio")}55`,
                    color: paletteVar("ratio"),
                  }}
                >
                  <LED color={paletteVar("ratio")} size={4} /> LIVE
                </span>
              </div>
              <PerfBadge value={ratioStats.vs7d} label="VS 7D" />
            </div>
            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={ratio}
                  format={(v) => (v < 0.001 ? v.toExponential(3) : v.toPrecision(4))}
                  color={paletteVar("ratio")}
                />
              </div>
              {/* RATIO has no dollar-change line — the empty space
                  here matches the height the CYPH + ZEC tiles leave
                  for theirs so all three sparklines align. */}
            </div>
            <div className="mt-3 min-h-[2rem]">
              {ratioSpark.length >= 2 && (
                <PhosphorSpark
                  values={ratioSpark}
                  color={paletteVar("ratio")}
                  width={300}
                  height={32}
                />
              )}
            </div>
            {/* RATIO at-a-glance row — promotes the historical
                averages to the same vertical position the CYPH +
                ZEC tiles use for their treasury / TX rows, keeping
                the three tiles visually parallel. */}
            {(ratioStats.avg24h != null ||
              ratioStats.avg7d != null ||
              ratioStats.avg30d != null) && (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("ratio")}33` }}
              >
                <NavCell
                  label="24H AVG"
                  value={ratioStats.avg24h ?? 0}
                  format={(v) => v.toPrecision(4)}
                  color={paletteVar("ratio")}
                />
                <NavCell
                  label="7D AVG"
                  value={ratioStats.avg7d ?? 0}
                  format={(v) => v.toPrecision(4)}
                  color={paletteVar("ratio")}
                />
                <NavCell
                  label="30D AVG"
                  value={ratioStats.avg30d ?? 0}
                  format={(v) => v.toPrecision(4)}
                  color={paletteVar("ratio")}
                />
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={ratioStats.vs24h}
                p7={ratioStats.vs7d}
                p30={ratioStats.vs30d}
                p90={null}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[10px]">
              <MetaRow
                label="SOURCE"
                value={quote?.marketState === "REGULAR" ? "INTRADAY" : "EXT-HRS"}
              />
              <MetaRow
                label="PERIOD"
                value={period === "1" ? "1D" : period === "all" ? "ALL" : period + "D"}
              />
            </div>
          </CornerBox>
        </Link>
      </section>

      {/* CHART + SUPPLY PANEL — `items-start` so the chart card
          doesn't stretch to match the much taller supply panel on
          desktop (which left a wedge of blank space below the chart
          on lg+ before, and made the mobile-stack feel airy). */}
      <section className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-2 md:gap-3 mb-2 md:mb-3 items-start">
        <CornerBox
          label="PRICE OVERLAY"
          action={
            <span
              className="hidden sm:flex items-center gap-3 text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.7 }}
            >
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-px"
                  style={{ background: paletteVar("cyph") }}
                />
                <span style={{ color: paletteVar("cyph") }}>CYPH</span>
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 border-t border-dashed"
                  style={{ borderColor: paletteVar("zec") }}
                />
                <span style={{ color: paletteVar("zec") }}>ZEC</span>
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 border-t border-dotted"
                  style={{ borderColor: paletteVar("ratio") }}
                />
                <span style={{ color: paletteVar("ratio") }}>RATIO</span>
              </span>
            </span>
          }
        >
          {/* Mobile gets a shorter height + narrower viewBox so the
              SVG doesn't stretch text horizontally (default 900-wide
              viewBox + preserveAspectRatio="none" was squishing axis
              labels to ~half their intended width on phones). */}
          <div className="block md:hidden">
            <MultiLineChartE
              data={history.map((h) => ({
                date: h.date,
                cyph: h.cyph,
                zec: h.zec,
                ratio: h.ratio,
              }))}
              height={180}
              viewBoxWidth={360}
            />
          </div>
          <div className="hidden md:block">
            <MultiLineChartE
              data={history.map((h) => ({
                date: h.date,
                cyph: h.cyph,
                zec: h.zec,
                ratio: h.ratio,
              }))}
              height={240}
            />
          </div>
        </CornerBox>

        <CornerBox
          label="ZEC SUPPLY"
          action={
            <Link
              href="/beta/stats"
              className="text-[10px] tracking-[0.2em] hover:underline transition-colors"
              style={{ color: paletteVar("ratio") }}
            >
              MORE →
            </Link>
          }
        >
          {circulating != null && (
            <>
              <BlockProgress
                pct={(circulating / 21e6) * 100}
                width={26}
                color={paletteVar("zec")}
                label="MINED"
                sub={`${((circulating / 21e6) * 100).toFixed(2)}%`}
              />
              <div
                className="text-[10px] mt-0.5"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                {(circulating / 1e6).toFixed(2)}M / 21M ZEC
              </div>
            </>
          )}
          {shieldedPct != null && (
            <div className="mt-3">
              <BlockProgress
                pct={shieldedPct}
                width={26}
                color={paletteVar("ratio")}
                label="SHIELDED"
                sub={`${shieldedPct.toFixed(2)}%`}
              />
              {circulating != null && (
                <div
                  className="text-[10px] mt-0.5"
                  style={{ color: paletteVar("text"), opacity: 0.7 }}
                >
                  {(
                    ((circulating * shieldedPct) / 100) /
                    1e6
                  ).toFixed(2)}
                  M ZEC in pools
                </div>
              )}
            </div>
          )}
          {/* Per-pool breakdown — only renders when at least one pool
              has a positive share so we never paint zeros pretending
              to be data. */}
          {shielded && (shielded.orchard + shielded.sapling + shielded.sprout + shielded.lockbox) > 0 && (
            <div className="grid grid-cols-4 gap-1 mt-2 text-[9px]">
              {(() => {
                // Per-pool ZEC counts → percentage of chain supply,
                // matching the way the legacy stats client renders.
                const chain =
                  (shielded.transparent ?? 0) +
                  shielded.sprout +
                  shielded.sapling +
                  shielded.orchard +
                  shielded.lockbox
                const cells = [
                  ["ORCHRD", shielded.orchard, POOL_COLORS.orchard],
                  ["SAPLNG", shielded.sapling, POOL_COLORS.sapling],
                  ["SPROUT", shielded.sprout, POOL_COLORS.sprout],
                  ["LOCKBX", shielded.lockbox, POOL_COLORS.lockbox],
                ] as const
                return cells.map(([l, amt, c]) => {
                  const pct = chain > 0 ? (amt / chain) * 100 : 0
                  return (
                    <div
                      key={l}
                      className="text-center px-1 py-1 border"
                      style={{ borderColor: c + "55" }}
                    >
                      <div style={{ color: c }}>{l}</div>
                      <div
                        className="font-bold tabular-nums"
                        style={{ color: c }}
                      >
                        {pct < 0.01 ? "0%" : pct.toFixed(1) + "%"}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
          {rankNeighbors.length > 0 && zecRank != null && (
            <div
              className="mt-3 pt-3"
              style={{ borderTop: `1px dashed ${paletteVar("text")}33` }}
            >
              <div
                className="text-[10px] tracking-[0.3em] mb-1.5"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                RANK NEIGHBORS
              </div>
              <div className="font-mono text-[10px] flex flex-col gap-0.5">
                {rankNeighbors.map((r) => {
                  const isZec = r.symbol === "ZEC"
                  const c = isZec
                    ? paletteVar("zec")
                    : paletteVar("text")
                  return (
                    <div
                      key={r.symbol + r.rank}
                      className="grid grid-cols-[28px_18px_46px_1fr_auto] gap-1.5 items-center transition-colors hover:bg-emerald-950/30 px-1"
                      style={{ color: c, opacity: isZec ? 1 : 0.7 }}
                    >
                      <span>{isZec ? "►" : " "}#{r.rank}</span>
                      <CoinLogo image={r.image ?? null} symbol={r.symbol} size={16} />
                      <span className={isZec ? "font-bold" : ""}>{r.symbol}</span>
                      <span className="opacity-70 tabular-nums">
                        {fmtCompactUSD(r.marketCap)}
                      </span>
                      <span
                        className="tabular-nums"
                        style={{
                          color:
                            r.change24h != null
                              ? r.change24h >= 0
                                ? paletteVar("cyph")
                                : E_STATIC.red
                              : paletteVar("text"),
                        }}
                      >
                        {r.change24h != null
                          ? `${r.change24h >= 0 ? "+" : ""}${r.change24h.toFixed(1)}%`
                          : "—"}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </CornerBox>
      </section>

      {/* TOOLS — interactive corner boxes */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-2 md:gap-3">
        {[
          { href: "/beta/estimator", t: "ESTIMATOR", s: "predict CYPH for any ZEC price", c: paletteVar("cyph") },
          { href: "/beta/portfolio", t: "PORTFOLIO", s: "track holdings · on-device", c: paletteVar("ratio") },
          { href: "/beta/stats", t: "ZEC STATS", s: "top-50 · supply · shielded · transactions", c: paletteVar("zec") },
        ].map((cta, i) => (
          <Link key={i} href={cta.href} className="block group">
            <CornerBox color={cta.c} interactive>
              <div className="flex items-center gap-2">
                <div
                  className="font-bold text-[12px] tracking-[0.2em]"
                  style={{ color: cta.c }}
                >
                  {cta.t}
                </div>
                <span className="ml-auto" style={{ color: cta.c }}>
                  →
                </span>
              </div>
              <div
                className="text-[11px] mt-0.5"
                style={{ color: paletteVar("text"), opacity: 0.65 }}
              >
                {cta.s}
              </div>
            </CornerBox>
          </Link>
        ))}
      </section>

      {/* FOOTER — PWA install, PiP pop-out, ABOUT link, and data
          attribution. PWA chip only appears on browsers with a
          deferrable install prompt (Chrome / Edge / Brave) or iOS
          Safari; PiP chip only on browsers exposing the Document PiP
          or HTMLVideoElement PiP API. Both wrap the production-grade
          components from the legacy site, rewrapped in the E theme
          via `components/beta/footer-buttons.tsx`. */}
      <footer className="mt-3 flex flex-wrap items-center gap-2 px-1">
        <BetaPwaInstall />
        <BetaPipPopout />
        <Link
          href="/beta/about"
          className="px-2 py-1 text-[10px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40 inline-flex items-center gap-1.5"
          style={{
            color: paletteVar("text"),
            opacity: 0.8,
            border: `1px solid ${paletteVar("text")}33`,
          }}
        >
          ABOUT · FAQ
        </Link>
        <span
          className="text-[10px] ml-auto"
          style={{ color: paletteVar("text"), opacity: 0.4 }}
        >
          data: yahoo · kraken · coingecko · coinmarketcap · cipherscan · cypherpunk.com
        </span>
      </footer>
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Tiny helpers — only used within this file so they live alongside.
// ──────────────────────────────────────────────────────────────────────
function PerfBadge({
  value,
  label,
}: {
  value: number | null | undefined
  label: string
}) {
  const ok = value != null && Number.isFinite(value)
  // Values smaller than half a basis-point round to "0.00%" in display,
  // so colouring + arrowing them as up/down lies to the user. Treat
  // that range as flat: neutral colour, no arrow.
  const flat = ok && Math.abs(value) < 0.005
  const color =
    !ok || flat
      ? paletteVar("text")
      : value >= 0
        ? paletteVar("cyph")
        : E_STATIC.red
  return (
    <div className="text-right text-[11px]">
      <div
        className="flex items-center justify-end gap-1"
        style={{ color, opacity: !ok ? 0.5 : flat ? 0.7 : 1 }}
      >
        <span>
          {!ok
            ? "—"
            : flat
              ? "0.00%"
              : `${value >= 0 ? "▲" : "▼"} ${Math.abs(value).toFixed(2)}%`}
        </span>
      </div>
      <div
        className="text-[9px]"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        {label}
      </div>
    </div>
  )
}

function NavCell({
  label,
  value,
  format,
  color,
  icon,
}: {
  label: string
  value: number
  format: (v: number) => string
  color: string
  icon?: React.ReactNode
}) {
  return (
    <div
      className="px-2 py-1.5 text-center"
      style={{
        background: `${color}0c`,
        borderRightWidth: 1,
        borderRightStyle: "solid",
        borderRightColor: `${color}22`,
      }}
    >
      <div
        className="text-[9px] tracking-wider inline-flex items-center justify-center gap-1"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {icon}
        {label}
      </div>
      <div
        className="text-[14px] font-bold tabular-nums leading-tight"
        style={{ color }}
      >
        <LiveNumber value={value} format={format} color={color} />
      </div>
    </div>
  )
}

function MetaRow({
  label,
  value,
  active = false,
  activeColor,
}: {
  label: React.ReactNode
  value: string
  active?: boolean
  activeColor?: string
}) {
  // When `active` is true, the row is the session sourcing the
  // current headline price. Render a soft tint + leading dot so the
  // user can trace the big number back to its session at a glance.
  // aria-label below covers screen-readers — the dot is purely
  // decorative, the prose ("current session — $1.21") carries the
  // meaning.
  const valueColor = active ? activeColor ?? paletteVar("text") : paletteVar("text")
  return (
    <div
      className="flex items-center justify-between py-1"
      style={{
        borderBottom: `1px dotted ${paletteVar("text")}22`,
        background: active && activeColor ? `${activeColor}10` : undefined,
      }}
    >
      <span
        className="inline-flex items-center gap-1"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {active && activeColor && (
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{
              width: 4,
              height: 4,
              background: activeColor,
              boxShadow: `0 0 4px ${activeColor}`,
            }}
          />
        )}
        {label}
      </span>
      <span className="font-bold tabular-nums" style={{ color: valueColor }}>
        {value}
      </span>
    </div>
  )
}

function fmtCompactNumberLocal(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K"
  return n.toFixed(0)
}
