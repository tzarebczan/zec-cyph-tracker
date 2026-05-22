"use client"

import { useMemo } from "react"
import Link from "next/link"
import useSWR from "swr"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  CornerBox,
  LED,
  BlockProgress,
  PhosphorSpark,
  LiveNumber,
  PerfGrid,
  ETabs,
  MultiLineChartE,
} from "./primitives"
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

const PERIODS = [
  ["7", "7D"],
  ["14", "14D"],
  ["30", "30D"],
  ["90", "90D"],
  ["180", "6M"],
  ["all", "ALL"],
] as const

type Period = (typeof PERIODS)[number][0]
const VALID_PERIODS = new Set(PERIODS.map(([v]) => v))

const POOL_COLORS = {
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

export function BetaDashboard() {
  const [period, setPeriod] = usePersistentState<Period>(
    "cyphzec.beta.dashboard.days",
    "90",
    (v): v is Period =>
      typeof v === "string" && VALID_PERIODS.has(v as Period)
  )

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

  const cyphPrice = pickLiveCyph(quote)
  const zecPrice =
    tick?.current?.zec?.price ?? prices?.current?.zec?.price ?? null
  const ratio =
    cyphPrice != null && zecPrice != null && zecPrice > 0
      ? cyphPrice / zecPrice
      : null

  const history = prices?.history ?? []
  const stats = prices?.stats

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

  return (
    <>
      {/* HEADER ROW — period selector + nav. Sits inside EShell which
          provides the brand + LED on the top nav strip. We render a
          second row dedicated to the period switcher so the desktop
          and mobile period chips look identical. */}
      <div className="flex items-center gap-2 mb-3 py-1.5">
        <span
          className="text-[10px] tracking-[0.3em] hidden sm:inline"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          PERIOD
        </span>
        <ETabs items={PERIODS} active={period} onChange={setPeriod} />
        <div className="flex-1" />
        {prices?.current && (
          <span
            className="text-[10px] tracking-[0.2em] hidden md:inline"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            {history.length} daily candles
          </span>
        )}
      </div>

      {/* THREE READOUTS — CYPH / ZEC / RATIO */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        {/* CYPH */}
        <CornerBox color={paletteVar("cyph")}>
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
                {quote?.marketState === "REGULAR" ? "LIVE" : quote?.marketState ?? "—"}
              </span>
            </div>
            <PerfBadge value={stats?.cyph.change24h} label="24H" />
          </div>
          <div className="text-3xl md:text-4xl font-bold mt-2 leading-none">
            <LiveNumber
              value={cyphPrice}
              format={(v) => "$" + v.toFixed(2)}
              color={paletteVar("cyph")}
            />
          </div>
          {/* Treasury NAV micro-tile row — only renders when both ZEC
              treasury + shares-out + ZEC price are present so we never
              show a half-empty card. */}
          {navPerShare != null && treasuryUsd != null && (
            <div
              className="mt-3 grid grid-cols-3 gap-px"
              style={{ border: `1px solid ${paletteVar("amber")}33` }}
            >
              <NavCell label="NAV/SHARE" value={navPerShare} format={(v) => "$" + v.toFixed(2)} color={paletteVar("amber")} />
              <NavCell label="TREASURY" value={treasuryUsd} format={fmtCompactUSD} color={paletteVar("amber")} />
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
                  className="text-[9px] tracking-wider"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
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
          {cyphSpark.length >= 2 && (
            <div className="mt-3">
              <PhosphorSpark
                values={cyphSpark}
                color={paletteVar("cyph")}
                width={300}
                height={32}
              />
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
          <div className="mt-2 grid grid-cols-2 gap-x-3 text-[10px]">
            <MetaRow
              label="PRE"
              value={
                quote?.preMarketPrice != null
                  ? "$" + quote.preMarketPrice.toFixed(2)
                  : "—"
              }
            />
            <MetaRow
              label="AFT"
              value={
                quote?.postMarketPrice != null
                  ? "$" + quote.postMarketPrice.toFixed(2)
                  : "—"
              }
            />
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

        {/* ZEC */}
        <CornerBox color={paletteVar("zec")}>
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
          <div className="text-3xl md:text-4xl font-bold mt-2 leading-none">
            <LiveNumber
              value={zecPrice}
              format={(v) => "$" + v.toFixed(2)}
              color={paletteVar("zec")}
            />
          </div>
          {zecSpark.length >= 2 && (
            <div className="mt-3">
              <PhosphorSpark
                values={zecSpark}
                color={paletteVar("zec")}
                width={300}
                height={32}
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
          <div className="mt-2 grid grid-cols-2 gap-x-3 text-[10px]">
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
              label="SHIELDED"
              value={shieldedPct != null ? `${shieldedPct.toFixed(1)}%` : "—"}
            />
            <MetaRow label="VOL 24H" value={fmtCompactUSD(zecStats?.volume24h ?? null)} />
          </div>
        </CornerBox>

        {/* RATIO */}
        <CornerBox color={paletteVar("ratio")}>
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
          <div className="text-3xl md:text-4xl font-bold mt-2 leading-none">
            <LiveNumber
              value={ratio}
              format={(v) => (v < 0.001 ? v.toExponential(3) : v.toPrecision(4))}
              color={paletteVar("ratio")}
            />
          </div>
          {ratioSpark.length >= 2 && (
            <div className="mt-3">
              <PhosphorSpark
                values={ratioSpark}
                color={paletteVar("ratio")}
                width={300}
                height={32}
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
          <div className="mt-2 grid grid-cols-2 gap-x-3 text-[10px]">
            <MetaRow
              label="24H AVG"
              value={
                ratioStats.avg24h != null
                  ? ratioStats.avg24h.toPrecision(4)
                  : "—"
              }
            />
            <MetaRow
              label="7D AVG"
              value={
                ratioStats.avg7d != null ? ratioStats.avg7d.toPrecision(4) : "—"
              }
            />
            <MetaRow
              label="30D AVG"
              value={
                ratioStats.avg30d != null ? ratioStats.avg30d.toPrecision(4) : "—"
              }
            />
            <MetaRow label="SOURCE" value={quote?.marketState === "REGULAR" ? "INTRADAY" : "EXT-HRS"} />
          </div>
        </CornerBox>
      </section>

      {/* CHART + SUPPLY PANEL */}
      <section className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-3 mb-3">
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
          <MultiLineChartE
            data={history.map((h) => ({
              date: h.date,
              cyph: h.cyph,
              zec: h.zec,
              ratio: h.ratio,
            }))}
            height={240}
          />
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
                      className="grid grid-cols-[28px_50px_1fr_auto] gap-1.5 items-center transition-colors hover:bg-emerald-950/30 px-1"
                      style={{ color: c, opacity: isZec ? 1 : 0.7 }}
                    >
                      <span>{isZec ? "►" : " "}#{r.rank}</span>
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
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { href: "/beta/estimator", t: "ESTIMATOR", s: "predict CYPH for any ZEC price", c: paletteVar("cyph") },
          { href: "/beta/portfolio", t: "PORTFOLIO", s: "track holdings · on-device", c: paletteVar("ratio") },
          { href: "/beta/stats", t: "RANKINGS", s: "top-50 mcap · ZEC supply · pools", c: paletteVar("zec") },
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
  const color = !ok
    ? paletteVar("text")
    : value >= 0
      ? paletteVar("cyph")
      : E_STATIC.red
  return (
    <div className="text-right text-[11px]">
      <div className="flex items-center justify-end gap-1" style={{ color }}>
        <span>
          {ok ? `${value >= 0 ? "▲" : "▼"} ${Math.abs(value).toFixed(2)}%` : "—"}
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
}: {
  label: string
  value: number
  format: (v: number) => string
  color: string
}) {
  return (
    <div
      className="px-2 py-1.5 text-center"
      style={{
        background: `${color}0c`,
        borderRight: `1px solid ${color}22`,
      }}
    >
      <div
        className="text-[9px] tracking-wider"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
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

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between py-1"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span style={{ color: paletteVar("text"), opacity: 0.6 }}>{label}</span>
      <span
        className="font-bold tabular-nums"
        style={{ color: paletteVar("text") }}
      >
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
