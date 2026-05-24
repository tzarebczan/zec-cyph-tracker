"use client"

import useSWR from "swr"
import { Skeleton } from "./primitives"
import { paletteVar } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import type { MarketsResponse, ZecStatsResponse } from "./api-types"

// ──────────────────────────────────────────────────────────────────────
// "What ZEC could be worth" — five-market valuation table.
//
// For each market we render rows of {share, implied ZEC price, multiple}
// where the implied price is `(marketCap × share) / zecCirculatingSupply`
// and the multiple is `impliedPrice / currentZecPrice`. The Dogecoin row
// is a small twist: instead of "share of DOGE", we phrase it as "ZEC
// trades at N× DOGE's market cap" because that frames the comparison
// the way crypto Twitter actually argues about it.
//
// Live data:
//   • /api/markets — BTC + DOGE + the stablecoin issuers (USDT, USDC,
//     DAI, …), all sourced from CoinMarketCap with CoinPaprika fallback.
//   • /api/zec-stats — ZEC circulating supply + current spot price.
//   • /api/ticker — gold spot price (we already poll this for the
//     ticker tape, so reusing it is free). The route formats prices
//     server-side as strings; we parse the formatted value back into
//     a number. A hard-coded fallback ($4,200) keeps the gold section
//     populated if the ticker fetch is partial.
//
// Two markets stay hard-coded because they lack clean live sources:
//   • Offshore wealth — research figure from BCG's Global Wealth
//     Report. Updated annually.
//   • Above-ground gold supply (oz) — World Gold Council figure.
//
// Layout: each row is a 3-column inline-style grid (share | price |
// multiple) so the column template works in Tailwind v4 without
// arbitrary-value parsing quirks. Section blocks share a parent gap so
// vertical rhythm stays consistent without per-section margins.
// ──────────────────────────────────────────────────────────────────────

/** Cross-border private wealth ("offshore wealth"). Source: Boston
 *  Consulting Group's *Global Wealth Report* — they peg cross-border
 *  private wealth at ~$11.3T as of the 2024 edition. Update annually. */
const OFFSHORE_WEALTH_USD = 11.3e12

/** Above-ground gold supply estimate, in troy ounces. World Gold
 *  Council pegs total above-ground stock at ~213,000 metric tonnes
 *  (≈6.85B troy oz). The commonly cited "all the gold ever mined"
 *  figure rounds up to ~7.5B oz to fold in central-bank reserves +
 *  recycled jewelry; we use 7.5B so the implied gold market cap
 *  matches the figure ZEC bulls cite. Refresh annually. */
const GOLD_TROY_OZ = 7.5e9

/** Fallback gold spot price (USD per troy oz). Used when /api/ticker
 *  doesn't surface a "gold" chip (Yahoo blocked, ticker cache cold,
 *  etc.). Pinned at $4,200 — the recent range — so the gold section
 *  still renders five rows even when the live fetch is partial. Mark
 *  the value as a fallback in the section header so the user knows
 *  it's not derived from a live feed. Update with the rough gold
 *  spot once a year. */
const GOLD_PRICE_FALLBACK_USD = 4200

interface TickerChip {
  key: string
  value: string
}
interface TickerResponse {
  chips: TickerChip[]
}

/** Parse a formatted ticker price like "$4,232.50" back into a number.
 *  /api/ticker formats prices server-side so the client doesn't ship a
 *  per-chip formatter, but here we need the raw number for the gold
 *  market-cap calc. The format is stable ("$N,NNN.NN") so strip
 *  everything that isn't digit/period/minus and parse. Returns null on
 *  any malformed input so callers can fall back rather than render NaN. */
function parseTickerNumeric(value: string | undefined | null): number | null {
  if (!value) return null
  const cleaned = value.replace(/[^0-9.\-]/g, "")
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Sum the headline stablecoins' market caps. USDT alone is >$120B and
 *  dwarfs the rest, but summing the top issuers gives a more honest
 *  total than any single issuer. We require USDT to be present before
 *  returning a number — otherwise the markets fetch hasn't landed and
 *  we'd surface a misleadingly tiny total from a partial response. */
function computeStablecoinMcap(
  markets: MarketsResponse | undefined
): number | null {
  if (!markets) return null
  const STABLES = ["USDT", "USDC", "DAI", "BUSD", "FDUSD", "USDe", "TUSD"]
  let sum = 0
  let hasUsdt = false
  for (const sym of STABLES) {
    const coin = markets.coins.find((c) => c.symbol === sym)
    if (coin?.marketCap != null) {
      sum += coin.marketCap
      if (sym === "USDT") hasUsdt = true
    }
  }
  return hasUsdt ? sum : null
}

interface ScenarioRow {
  /** Display label for the share column: "1%", "0.5%", "= DOGE", etc. */
  label: string
  /** Implied ZEC price in USD if this scenario plays out. Null while
   *  the upstream data this row depends on hasn't loaded yet. */
  zecPrice: number | null
  /** `zecPrice / currentZecPrice`. Null when either is missing. */
  multiple: number | null
}

interface MarketBlock {
  key: string
  name: string
  /** Live market cap in USD. Null while loading; used for the right-
   *  aligned reference value next to each section heading. */
  mcap: number | null
  /** Optional note rendered below the market cap (e.g. "fallback"
   *  when the gold price came from the hard-coded constant rather
   *  than the live ticker). */
  note?: string
  rows: ScenarioRow[]
}

interface BuildCtx {
  marketsResp?: MarketsResponse
  goldPriceUsd: number
  goldIsLive: boolean
  zecSupply: number | null
  zecPrice: number | null
}

function findCoinMcap(
  markets: MarketsResponse | undefined,
  symbol: string
): number | null {
  return markets?.coins.find((c) => c.symbol === symbol)?.marketCap ?? null
}

function computeShareRow(
  mcap: number | null,
  share: number,
  zecSupply: number | null,
  zecPrice: number | null,
  fmtShare: (s: number) => string
): ScenarioRow {
  const zp =
    mcap != null && zecSupply != null && zecSupply > 0
      ? (mcap * share) / zecSupply
      : null
  return {
    label: fmtShare(share),
    zecPrice: zp,
    multiple:
      zp != null && zecPrice != null && zecPrice > 0 ? zp / zecPrice : null,
  }
}

function computeMultRow(
  baseMcap: number | null,
  mult: number,
  zecSupply: number | null,
  zecPrice: number | null,
  label: string
): ScenarioRow {
  const zp =
    baseMcap != null && zecSupply != null && zecSupply > 0
      ? (baseMcap * mult) / zecSupply
      : null
  return {
    label,
    zecPrice: zp,
    multiple:
      zp != null && zecPrice != null && zecPrice > 0 ? zp / zecPrice : null,
  }
}

function fmtSharePct(share: number): string {
  const pct = share * 100
  if (pct >= 1) return `${pct.toFixed(0)}%`
  if (pct >= 0.1) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(2)}%`
}

function buildSections(ctx: BuildCtx): MarketBlock[] {
  const { marketsResp, goldPriceUsd, goldIsLive, zecSupply, zecPrice } = ctx
  const btcMcap = findCoinMcap(marketsResp, "BTC")
  const dogeMcap = findCoinMcap(marketsResp, "DOGE")
  const goldMcap = goldPriceUsd * GOLD_TROY_OZ
  const stablesMcap = computeStablecoinMcap(marketsResp)

  return [
    {
      key: "btc",
      name: "Bitcoin",
      mcap: btcMcap,
      rows: [0.01, 0.02, 0.05, 0.1].map((s) =>
        computeShareRow(btcMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "offshore",
      name: "Offshore wealth",
      mcap: OFFSHORE_WEALTH_USD,
      rows: [0.001, 0.005, 0.01].map((s) =>
        computeShareRow(OFFSHORE_WEALTH_USD, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "gold",
      name: "Gold",
      mcap: goldMcap,
      // Hint when the gold price came from the fallback constant — the
      // implied prices are still useful for the comparison, but the
      // user should know they're not derived from a live spot feed.
      note: goldIsLive ? undefined : "est.",
      rows: [0.0005, 0.001, 0.005].map((s) =>
        computeShareRow(goldMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "stables",
      name: "Stablecoins",
      mcap: stablesMcap,
      rows: [0.05, 0.1, 0.25].map((s) =>
        computeShareRow(stablesMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "doge",
      name: "Dogecoin",
      mcap: dogeMcap,
      rows: [1, 2, 5].map((m) =>
        computeMultRow(
          dogeMcap,
          m,
          zecSupply,
          zecPrice,
          m === 1 ? "= DOGE" : `${m}× DOGE`
        )
      ),
    },
  ]
}

function fmtImpliedPrice(p: number): string {
  return "$" + Math.round(p).toLocaleString("en-US")
}

function fmtMultiple(m: number): string {
  return `${m.toFixed(1)}×`
}

function snapshotLabel(): string {
  return new Date()
    .toLocaleDateString("en-US", { month: "long", year: "numeric" })
    .toUpperCase()
}

// Shared inline grid template so all rows + all sections line up
// pixel-perfectly. SHARE column is fixed at ~5rem (wide enough for
// "= DOGE" / "0.05%" without ellipsis); price flexes in the middle;
// multiple is content-sized with a min so "1.0×" and "100.0×" share
// a stable width.
const ROW_GRID = {
  display: "grid",
  gridTemplateColumns: "5rem 1fr minmax(3.5rem, auto)",
  columnGap: "0.75rem",
  alignItems: "baseline",
} as const

export function WhatIfTable() {
  const { data: markets } = useSWR<MarketsResponse>(
    "/api/markets",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  const { data: ticker } = useSWR<TickerResponse>(
    "/api/ticker",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )

  const goldPriceLive = parseTickerNumeric(
    ticker?.chips.find((c) => c.key === "gold")?.value
  )
  const goldIsLive = goldPriceLive != null
  // Fall back to a recent gold spot so the section never blanks. The
  // implied prices are still informative even with a slightly stale
  // gold spot, and the section header flags the estimate.
  const goldPriceUsd = goldPriceLive ?? GOLD_PRICE_FALLBACK_USD

  const zecSupply = zecStats?.circulating ?? null
  const zecPrice = zecStats?.price ?? null

  const sections = buildSections({
    marketsResp: markets,
    goldPriceUsd,
    goldIsLive,
    zecSupply,
    zecPrice,
  })

  return (
    <div className="max-w-2xl mx-auto py-1 md:py-3 flex flex-col gap-5 md:gap-7">
      {/* HEADLINE — sans-serif "worth" in cyph-green, everything else
          in the default text color. Sized so the line fits within
          max-w-2xl on desktop without wrapping but still shrinks
          gracefully on mobile. */}
      <h1
        className="font-sans font-bold tracking-tight leading-[1.05]"
        style={{
          color: paletteVar("text"),
          fontSize: "clamp(1.75rem, 4.8vw, 2.75rem)",
        }}
      >
        What ZEC could be{" "}
        <span
          style={{
            color: paletteVar("cyph"),
            textShadow: `0 0 14px ${paletteVar("cyph")}55`,
          }}
        >
          worth
        </span>
        .
      </h1>

      {/* MARKETS — five sections, identical structure. Parent gap drives
          vertical rhythm so we don't fight per-section margins. */}
      {sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}

      {/* FOOTER — snapshot timestamp + ZEC price on the left, ./cypherpunk
          mark on the right. Subtle border-top so the footer reads as a
          separate strip without a heavy divider. */}
      <footer
        className="flex items-center justify-between mt-1 pt-3 border-t text-[10px] tracking-[0.15em]"
        style={{
          borderColor: paletteVar("text") + "22",
          color: paletteVar("cyph"),
        }}
      >
        <span style={{ opacity: 0.75 }}>
          // SNAPSHOT {snapshotLabel()}
          {zecPrice != null && (
            <>
              {" · "}ZEC ${zecPrice.toFixed(2)}
            </>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          ./cypherpunk
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2"
            style={{
              background: paletteVar("cyph"),
              boxShadow: `0 0 6px ${paletteVar("cyph")}88`,
            }}
          />
        </span>
      </footer>
    </div>
  )
}

function Section({ section }: { section: MarketBlock }) {
  return (
    <section className="flex flex-col gap-2.5">
      {/* Section header: sans-serif name on the left + compact market
          cap on the right. Underline divider sits flush with the
          header so the rows below feel attached. */}
      <div
        className="flex items-baseline justify-between gap-3 pb-1.5 border-b"
        style={{ borderColor: paletteVar("text") + "22" }}
      >
        <h2
          className="font-sans font-bold leading-none"
          style={{
            color: paletteVar("text"),
            fontSize: "clamp(1.125rem, 2.8vw, 1.5rem)",
            letterSpacing: "-0.01em",
          }}
        >
          {section.name}
        </h2>
        <div className="flex items-baseline gap-2 shrink-0">
          {section.note && (
            <span
              className="text-[9px] tracking-[0.2em]"
              style={{ color: paletteVar("text"), opacity: 0.35 }}
            >
              {section.note.toUpperCase()}
            </span>
          )}
          <span
            className="tabular-nums text-[12px] md:text-[13px]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            {section.mcap != null ? (
              fmtCompactUSD(section.mcap)
            ) : (
              <Skeleton style={{ width: 52, height: 11 }} />
            )}
          </span>
        </div>
      </div>
      {/* Rows — each row is its own grid using ROW_GRID so the columns
          stay aligned even if a single row's content is unusually wide
          (the multiplier column has a minmax so 1.0× and 100.0× share
          a stable position). */}
      <div className="flex flex-col gap-1.5">
        {section.rows.map((row, i) => (
          <div
            key={i}
            className="tabular-nums text-[13px] md:text-[15px]"
            style={ROW_GRID}
          >
            <span style={{ color: paletteVar("text") }}>{row.label}</span>
            <span
              className="text-right"
              style={{ color: paletteVar("text") }}
            >
              {row.zecPrice != null ? (
                fmtImpliedPrice(row.zecPrice)
              ) : (
                <Skeleton style={{ width: 56, height: 12 }} />
              )}
            </span>
            <span
              className="text-right font-bold"
              style={{
                color: paletteVar("cyph"),
                // Big multipliers get a subtle glow — pulls the eye to
                // the rows that would actually matter.
                textShadow:
                  row.multiple != null && row.multiple >= 10
                    ? `0 0 8px ${paletteVar("cyph")}66`
                    : "none",
              }}
            >
              {row.multiple != null ? (
                fmtMultiple(row.multiple)
              ) : (
                <Skeleton style={{ width: 36, height: 12 }} />
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
