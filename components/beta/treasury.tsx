"use client"

import useSWR from "swr"
import { CornerBox, LiveNumber } from "./primitives"
import { paletteVar } from "./theme"
import { fmtCompactUSD, fmtUSD, swrFetcher } from "./format"
import type {
  HoldingsResponse,
  PricesResponse,
  QuoteSnapshot,
} from "./api-types"

export function BetaTreasury() {
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=7",
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
  const buys = txs.filter((t) => t.type === "buy" && (t.amount ?? 0) > 0)
  const maxBuy = buys.length > 0 ? Math.max(...buys.map((t) => t.amount ?? 0)) : 0

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

      <CornerBox
        color={paletteVar("amber")}
        label="PROOF-OF-RESERVES · LIVE"
        className="mb-3"
      >
        <div
          className="grid gap-4 items-end"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
        >
          <div>
            <div
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              ZEC HELD IN TREASURY
            </div>
            <div
              className="font-bold text-3xl md:text-4xl tabular-nums mt-1"
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
                className="text-[12px] mt-1"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                ≈{" "}
                <LiveNumber
                  value={treasuryUsd}
                  format={fmtCompactUSD}
                  color={paletteVar("cyph")}
                />
                {pctCirculating != null && (
                  <>
                    {" · "}
                    {pctCirculating.toFixed(2)}% of circulating supply
                  </>
                )}
              </div>
            )}
            {holdings?.summary.lastTransactionAt && (
              <div className="flex gap-2 mt-3 flex-wrap text-[10px]">
                <span
                  className="px-2 py-1 border"
                  style={{
                    borderColor: `${paletteVar("text")}33`,
                    color: paletteVar("text"),
                    opacity: 0.7,
                  }}
                >
                  LAST UPDATE{" "}
                  {holdings.summary.lastTransactionAt.slice(0, 10)}
                </span>
                {buys.length > 0 && (
                  <span
                    className="px-2 py-1 border"
                    style={{
                      borderColor: `${paletteVar("cyph")}55`,
                      color: paletteVar("cyph"),
                    }}
                  >
                    {buys.length} disclosed acquisitions
                  </span>
                )}
              </div>
            )}
          </div>
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}
          >
            {mcap != null && treasuryUsd != null && (
              <Tile
                label="% CYPH MCAP"
                value={`${((treasuryUsd / mcap) * 100).toFixed(1)}%`}
                color={paletteVar("ratio")}
              />
            )}
            {navPerShare != null && (
              <Tile
                label="NAV / SHARE"
                color={paletteVar("cyph")}
                liveValue={navPerShare}
              />
            )}
            {avgCost != null && (
              <Tile
                label="AVG COST"
                value={fmtUSD(avgCost)}
                color={paletteVar("amber")}
              />
            )}
            {totalCost != null && (
              <Tile
                label="TOTAL COST"
                value={fmtCompactUSD(totalCost)}
                color={paletteVar("text")}
              />
            )}
          </div>
        </div>
      </CornerBox>

      <CornerBox
        label="ACQUISITION TIMELINE"
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
                    style={{ color: paletteVar("text"), opacity: 0.7, minWidth: 80 }}
                  >
                    {t.date.slice(0, 10)}
                  </span>
                  <span
                    className="text-[12px] tabular-nums font-bold"
                    style={{ color: paletteVar("zec"), minWidth: 96 }}
                  >
                    +{amt >= 1000 ? (amt / 1000).toFixed(1) + "k" : amt.toFixed(0)} ZEC
                  </span>
                  <span
                    className="text-[12px] tabular-nums"
                    style={{ minWidth: 72 }}
                  >
                    {t.unitPrice != null ? `@ $${t.unitPrice.toFixed(2)}` : "—"}
                  </span>
                  <div
                    className="whitespace-pre text-[11px] flex-1 min-w-[120px] order-5 md:order-none basis-full md:basis-auto"
                    style={{ color: paletteVar("zec"), opacity: 0.85 }}
                  >
                    {"█".repeat(fillW)}
                    <span style={{ opacity: 0.2 }}>{"░".repeat(24 - fillW)}</span>
                  </div>
                  {t.totalValue != null && (
                    <span
                      className="text-[10px] tabular-nums ml-auto"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      {fmtCompactUSD(t.totalValue)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CornerBox>

      {/* Always-visible attribution — the data sources don't change
          based on whether the shielded breakdown is currently
          available, so don't gate this on `zecStats?.shieldedSource`. */}
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

function Tile({
  label,
  value,
  liveValue,
  color,
}: {
  label: string
  value?: string
  liveValue?: number
  color: string
}) {
  return (
    <div
      className="px-3 py-2 border"
      style={{ borderColor: `${color}44` }}
    >
      <div
        className="text-[9px]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>
        {liveValue != null ? (
          <LiveNumber
            value={liveValue}
            format={(v) => "$" + v.toFixed(2)}
            color={color}
          />
        ) : (
          value ?? "—"
        )}
      </div>
    </div>
  )
}
