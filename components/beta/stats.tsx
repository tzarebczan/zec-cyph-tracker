"use client"

import { useState } from "react"
import useSWR from "swr"
import {
  CornerBox,
  BlockProgress,
  MultiLineChartE,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import type {
  MarketsResponse,
  PricesResponse,
  ZecStatsResponse,
} from "./api-types"

const POOL_COLORS = {
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

type StatsTab = "rankings" | "supply" | "volume"

export function BetaStats() {
  const [tab, setTab] = useState<StatsTab>("rankings")
  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 5 * 60_000,
    keepPreviousData: true,
  })
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  const { data: prices90 } = useSWR<PricesResponse>(
    "/api/prices?days=90",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )

  const coins = markets?.coins ?? []
  const zecCoin = coins.find((c) => c.symbol === "ZEC")
  const zecRank = zecCoin?.rank ?? zecStats?.rank ?? null
  const zecMcap = zecCoin?.marketCap ?? zecStats?.marketCap ?? null
  const zecSupply = zecCoin?.circulatingSupply ?? zecStats?.circulating ?? null
  const nextCoin =
    zecRank != null ? coins.find((c) => c.rank === zecRank - 1) : null
  const deltaToNextPrice =
    nextCoin?.marketCap != null && zecMcap != null && zecSupply != null && zecSupply > 0
      ? (nextCoin.marketCap - zecMcap) / zecSupply
      : null
  const shielded = zecStats?.shieldedBreakdown ?? null
  const shieldedPct = zecStats?.shieldedPct ?? shielded?.pct ?? null

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">
          RANKINGS · SUPPLY
        </h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          Live top-50 leaderboard · ZEC supply data
        </span>
      </div>

      {/* Highlight banner — only when we have ZEC data to highlight */}
      {zecRank != null && (
        <CornerBox color={paletteVar("zec")} className="mb-3">
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] items-center gap-4">
            <div
              className="font-bold text-3xl tabular-nums"
              style={{
                color: paletteVar("zec"),
                textShadow: `0 0 8px ${paletteVar("zec")}55`,
              }}
            >
              #{zecRank}
            </div>
            <div>
              <div
                className="text-[10px] tracking-[0.3em]"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                ZCASH · ZEC
              </div>
              <div className="text-xl font-bold tabular-nums">
                {fmtCompactUSD(zecMcap)}{" "}
                <span
                  className="text-[11px]"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  market cap
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {nextCoin && deltaToNextPrice != null && (
                <div
                  className="px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("cyph")}55` }}
                >
                  <div
                    className="text-[9px]"
                    style={{ color: paletteVar("text"), opacity: 0.6 }}
                  >
                    FLIP {nextCoin.symbol}
                  </div>
                  <div
                    className="font-bold tabular-nums"
                    style={{ color: paletteVar("cyph") }}
                  >
                    +${deltaToNextPrice.toFixed(2)}
                  </div>
                </div>
              )}
              {shieldedPct != null && (
                <div
                  className="px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("ratio")}55` }}
                >
                  <div
                    className="text-[9px]"
                    style={{ color: paletteVar("text"), opacity: 0.6 }}
                  >
                    SHIELDED
                  </div>
                  <div
                    className="font-bold tabular-nums"
                    style={{ color: paletteVar("ratio") }}
                  >
                    {shieldedPct.toFixed(2)}%
                  </div>
                </div>
              )}
            </div>
          </div>
        </CornerBox>
      )}

      {/* Sub-tabs */}
      <div
        className="flex items-center gap-1 mb-3 border-b overflow-x-auto"
        style={{ borderColor: `${paletteVar("text")}33` }}
      >
        {(
          [
            ["rankings", "RANKINGS"],
            ["supply", "ZEC SUPPLY"],
            ["volume", "VOLUME"],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className="px-3 py-1.5 text-[11px] font-bold transition-colors relative whitespace-nowrap"
            style={{
              color: tab === v ? paletteVar("cyph") : paletteVar("text"),
              opacity: tab === v ? 1 : 0.65,
            }}
          >
            {l}
            {tab === v && (
              <span
                className="absolute left-0 right-0 -bottom-px h-[1px]"
                style={{
                  background: paletteVar("cyph"),
                  boxShadow: `0 0 6px ${paletteVar("cyph")}`,
                }}
              />
            )}
          </button>
        ))}
      </div>

      {tab === "rankings" && (
        <CornerBox label="TOP-50 MARKET CAP · LIVE">
          <div className="overflow-x-auto">
            <div
              className="grid gap-0 px-1 py-1 border-b text-[9px] tracking-[0.2em] min-w-[600px]"
              style={{
                gridTemplateColumns: "40px 56px 1fr 100px 80px 110px",
                borderColor: `${paletteVar("text")}33`,
                color: paletteVar("text"),
                opacity: 0.7,
              }}
            >
              <span>RANK</span>
              <span />
              <span>COIN</span>
              <span className="text-right">PRICE</span>
              <span className="text-right">24H</span>
              <span className="text-right">MCAP</span>
            </div>
            {coins.length === 0 && (
              <div
                className="px-3 py-6 text-[11px] text-center"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                Loading rankings…
              </div>
            )}
            {coins.map((r) => {
              const isZec = r.symbol === "ZEC"
              const color = isZec ? paletteVar("zec") : paletteVar("text")
              return (
                <div
                  key={r.symbol + r.rank}
                  className="grid gap-0 px-1 py-2 items-center transition-colors hover:bg-emerald-950/30 min-w-[600px]"
                  style={{
                    gridTemplateColumns: "40px 56px 1fr 100px 80px 110px",
                    borderBottom: `1px dotted ${paletteVar("text")}22`,
                    background: isZec ? "rgba(253, 224, 71, 0.08)" : undefined,
                  }}
                >
                  <span
                    className="text-[11px] tabular-nums font-bold"
                    style={{
                      color: isZec ? paletteVar("zec") : paletteVar("text"),
                      opacity: isZec ? 1 : 0.7,
                    }}
                  >
                    {isZec ? "►" : " "}#{r.rank}
                  </span>
                  <div
                    className="size-7 border flex items-center justify-center text-[10px] font-bold"
                    style={{ borderColor: `${color}55`, color }}
                  >
                    {r.symbol.slice(0, 2)}
                  </div>
                  <div>
                    <div className="text-[12px] font-bold" style={{ color }}>
                      {r.symbol}
                    </div>
                    <div
                      className="text-[10px] truncate"
                      style={{ color: paletteVar("text"), opacity: 0.5 }}
                    >
                      {r.name}
                    </div>
                  </div>
                  <span className="text-[11px] text-right tabular-nums">
                    {r.price != null && Number.isFinite(r.price)
                      ? r.price < 1
                        ? "$" + r.price.toFixed(4)
                        : "$" + r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })
                      : "—"}
                  </span>
                  <span
                    className="text-[11px] text-right tabular-nums"
                    style={{
                      color:
                        r.change24h == null
                          ? paletteVar("text")
                          : r.change24h >= 0
                            ? paletteVar("cyph")
                            : E_STATIC.red,
                    }}
                  >
                    {r.change24h != null
                      ? `${r.change24h >= 0 ? "▲" : "▼"} ${Math.abs(r.change24h).toFixed(2)}%`
                      : "—"}
                  </span>
                  <span className="text-[11px] text-right tabular-nums">
                    {fmtCompactUSD(r.marketCap)}
                  </span>
                </div>
              )
            })}
          </div>
        </CornerBox>
      )}

      {tab === "supply" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <CornerBox label="CIRCULATING SUPPLY" color={paletteVar("zec")}>
            {zecSupply != null ? (
              <>
                <div
                  className="text-3xl font-bold tabular-nums"
                  style={{
                    color: paletteVar("zec"),
                    textShadow: `0 0 8px ${paletteVar("zec")}44`,
                  }}
                >
                  {(zecSupply / 1e6).toFixed(2)}M ZEC
                </div>
                <div
                  className="text-[10px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  of 21M max supply
                </div>
                <div className="mt-3">
                  <BlockProgress
                    pct={(zecSupply / 21e6) * 100}
                    width={28}
                    color={paletteVar("zec")}
                    label="MINED"
                    sub={`${((zecSupply / 21e6) * 100).toFixed(2)}%`}
                  />
                </div>
                <div
                  className="text-[10px] mt-2"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  ~{((21e6 - zecSupply) / 1e6).toFixed(2)}M ZEC remaining to mint
                </div>
              </>
            ) : (
              <div
                className="text-[11px]"
                style={{ color: paletteVar("text"), opacity: 0.5 }}
              >
                Loading supply…
              </div>
            )}
          </CornerBox>
          <CornerBox
            label="SHIELDED POOLS"
            color={paletteVar("ratio")}
            action={
              <a
                href="https://zechub.wiki/zcashdocs/zcash-overview/shielded-pools"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] tracking-[0.2em] hover:underline"
                style={{ color: paletteVar("ratio") }}
              >
                LEARN →
              </a>
            }
          >
            {shieldedPct != null && zecSupply != null ? (
              <>
                <div
                  className="text-3xl font-bold tabular-nums"
                  style={{
                    color: paletteVar("ratio"),
                    textShadow: `0 0 8px ${paletteVar("ratio")}44`,
                  }}
                >
                  {(((zecSupply * shieldedPct) / 100) / 1e6).toFixed(2)}M ZEC
                </div>
                <div
                  className="text-[10px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  {shieldedPct.toFixed(2)}% of circulating supply
                </div>
                <div className="mt-3">
                  <BlockProgress
                    pct={shieldedPct}
                    width={28}
                    color={paletteVar("ratio")}
                    label="SHIELDED"
                    sub={`${shieldedPct.toFixed(2)}%`}
                  />
                </div>
                {shielded && (
                  <div className="grid grid-cols-4 gap-1 mt-3 text-[9px]">
                    {(() => {
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
                            className="text-center px-1 py-1.5 border"
                            style={{ borderColor: c + "55" }}
                          >
                            <div style={{ color: c }}>{l}</div>
                            <div
                              className="font-bold tabular-nums"
                              style={{ color: c }}
                            >
                              {pct < 0.01 ? "0%" : pct.toFixed(2) + "%"}
                            </div>
                          </div>
                        )
                      })
                    })()}
                  </div>
                )}
              </>
            ) : (
              <div
                className="text-[11px]"
                style={{ color: paletteVar("text"), opacity: 0.5 }}
              >
                Loading shielded data…
              </div>
            )}
          </CornerBox>
          <div className="md:col-span-2">
            <CornerBox label="PRICE HISTORY · 90D">
              <MultiLineChartE
                data={(prices90?.history ?? []).map((h) => ({
                  date: h.date,
                  cyph: h.cyph,
                  zec: h.zec,
                  ratio: h.ratio,
                }))}
                height={220}
                showRatio={false}
              />
            </CornerBox>
          </div>
        </div>
      )}

      {tab === "volume" && (
        <CornerBox label="ZEC VOLUME · LAST 30D">
          {zecStats?.volume24h != null && (
            <>
              <div
                className="text-3xl font-bold tabular-nums"
                style={{
                  color: paletteVar("zec"),
                  textShadow: `0 0 8px ${paletteVar("zec")}44`,
                }}
              >
                {fmtCompactUSD(zecStats.volume24h)}
              </div>
              <div
                className="text-[10px] mt-1"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                last 24h trading volume across all exchanges
              </div>
            </>
          )}
          {zecStats?.volumeSeries && zecStats.volumeSeries.length >= 2 ? (
            <div className="mt-4">
              <VolumeBars series={zecStats.volumeSeries} />
            </div>
          ) : (
            <div
              className="text-[11px] mt-2"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              Loading volume series…
            </div>
          )}
        </CornerBox>
      )}
    </>
  )
}

/** Compact phosphor bar chart for the 30D volume series. Inline so
 *  we don't pull in recharts just for this surface. */
function VolumeBars({ series }: { series: [number, number][] }) {
  const max = Math.max(...series.map(([, v]) => v))
  const min = Math.min(...series.map(([, v]) => v))
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8px,1fr))] gap-px h-32 items-end">
      {series.map(([ts, v], i) => {
        const h = max > 0 ? Math.max(2, (v / max) * 100) : 0
        return (
          <div
            key={i}
            title={`${new Date(ts).toISOString().slice(0, 10)}: ${fmtCompactUSD(v)}`}
            style={{
              height: h + "%",
              background: paletteVar("zec"),
              boxShadow: `0 0 4px ${paletteVar("zec")}66`,
              opacity: 0.6 + 0.4 * ((v - min) / (max - min || 1)),
            }}
          />
        )
      })}
    </div>
  )
}
