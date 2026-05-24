"use client"

import useSWR from "swr"
import { Skeleton } from "./primitives"
import { paletteVar } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import type { MarketsResponse, ZecStatsResponse } from "./api-types"

// ──────────────────────────────────────────────────────────────────────
// "What ZEC could be worth" — five-market valuation table.
//
// For each market we render rows of {SHARE, IMPLIED ZEC PRICE, MULTIPLE}
// where the implied price is `(marketCap × share) / zecCirculatingSupply`
// and the multiple is `impliedPrice / currentZecPrice`. The Dogecoin row
// is a small twist: instead of "share of DOGE", we phrase it as "ZEC
// trades at N× DOGE's market cap" because that frames the comparison
// the way crypto Twitter actually argues about it.
//
// Three live data sources:
//   • /api/markets — BTC + DOGE + the stablecoin issuers (USDT, USDC,
//     DAI, …). All sourced from CoinMarketCap with CoinPaprika fallback.
//   • /api/zec-stats — ZEC circulating supply + current spot price.
//   • /api/ticker — gold spot price (we already poll this for the
//     ticker tape, so reusing it is free). Returns a formatted string
//     ("$4,232.50") which we parse back into a number; the formatter
//     is stable enough that this is safer than adding a new field to
//     the API response.
//
// Two markets are hard-coded because they don't have a clean live
// source:
//   • Offshore wealth — research figure from BCG's Global Wealth Report.
//   • Gold above-ground supply (oz) — World Gold Council estimate.
// Both are well-commented near the constants so an annual refresh is
// just a number change.
// ──────────────────────────────────────────────────────────────────────

/** Cross-border private wealth ("offshore wealth"). Source: Boston
 *  Consulting Group's *Global Wealth Report* — they peg cross-border
 *  private wealth at ~$11.3T as of the 2024 edition. Update when BCG
 *  publishes the next annual; the figure moves slowly enough that a
 *  hard-coded snapshot is fine for the order-of-magnitude framing this
 *  table is going for. */
const OFFSHORE_WEALTH_USD = 11.3e12

/** Above-ground gold supply estimate, in troy ounces. World Gold
 *  Council pegs total above-ground stock at ~213,000 metric tonnes
 *  (≈6.85B troy oz at 32,150.7 oz/tonne). The "gold market cap" number
 *  people usually quote rounds up to ~7.5B oz to fold in
 *  central-bank-held bars + recycled jewelry as one bucket — using 7.5B
 *  here lines our gold-market cap up with the figure ZEC bulls cite.
 *  Refresh once a year. */
const GOLD_TROY_OZ = 7.5e9

/** Subset of /api/ticker's response that this component cares about.
 *  We don't import the full TickerResponse type because the live route
 *  file lives in /app and we'd be coupling component types to the
 *  server's full output shape. */
interface TickerChip {
  key: string
  value: string
}
interface TickerResponse {
  chips: TickerChip[]
}

/** Parse a formatted ticker price like "$4,232.50" back into a number.
 *  The ticker route formats server-side so the client doesn't ship a
 *  per-chip formatter, but here we need the raw number to multiply by
 *  the gold-supply estimate. The format is stable (always "$N,NNN.NN")
 *  so a regex strip-and-parse is safer than it sounds. Returns null on
 *  any malformed input rather than NaN so we can gate on a null check
 *  in the row builder. */
function parseTickerNumeric(value: string | undefined | null): number | null {
  if (!value) return null
  const cleaned = value.replace(/[^0-9.\-]/g, "")
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Sum the headline stablecoins' market caps to get a "stablecoin
 *  total" figure. USDT alone is >$120B which dwarfs the rest, but
 *  summing the top issuers gives a more honest total than picking a
 *  single tracker. We require USDT to be present before returning a
 *  number — otherwise the markets fetch hasn't landed yet and the
 *  function would surface a misleadingly tiny number from one of the
 *  smaller issuers having loaded first. */
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
  /** Display label for the SHARE column: "1%", "0.5%", "= DOGE", etc. */
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
  rows: ScenarioRow[]
}

interface BuildCtx {
  marketsResp?: MarketsResponse
  goldPriceUsd?: number
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
    multiple: zp != null && zecPrice != null && zecPrice > 0 ? zp / zecPrice : null,
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
    multiple: zp != null && zecPrice != null && zecPrice > 0 ? zp / zecPrice : null,
  }
}

function fmtSharePct(share: number): string {
  const pct = share * 100
  if (pct >= 1) return `${pct.toFixed(0)}%`
  if (pct >= 0.1) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(2)}%`
}

function buildSections(ctx: BuildCtx): MarketBlock[] {
  const { marketsResp, goldPriceUsd, zecSupply, zecPrice } = ctx
  const btcMcap = findCoinMcap(marketsResp, "BTC")
  const dogeMcap = findCoinMcap(marketsResp, "DOGE")
  const goldMcap = goldPriceUsd != null ? goldPriceUsd * GOLD_TROY_OZ : null
  const stablesMcap = computeStablecoinMcap(marketsResp)

  // Each market's row count and chosen share tiers are picked to land
  // on an interesting range of multiples — e.g. for BTC at $1.55T even
  // 1% is already > current ZEC mcap, so we walk up to 10%. Gold is so
  // much bigger that we step at 0.05%, 0.1%, 0.5% to keep the multiples
  // in the same order of magnitude as the others.
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
  // Round to whole dollars and use locale commas — values cover a
  // wide range ($600 → $9,500+) so a single format keeps the column
  // readable without per-row decimal-place toggling.
  return "$" + Math.round(p).toLocaleString("en-US")
}

function fmtMultiple(m: number): string {
  // Always one decimal so the column stays visually aligned ("1.5×"
  // and "15.1×" both render the same width font-wise with tabular-nums).
  return `${m.toFixed(1)}×`
}

function snapshotLabel(): string {
  // "MAY 2026" / "DECEMBER 2025" — read as a casual timestamp; we don't
  // need day-precision because the implied prices update live anyway.
  return new Date()
    .toLocaleDateString("en-US", { month: "long", year: "numeric" })
    .toUpperCase()
}

export function WhatIfTable() {
  // Same SWR keys as the rest of the app — so anyone viewing this page
  // after the dashboard / stats page reuses the already-cached data.
  // refreshInterval is the standard 5min for slow-moving market caps.
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

  const goldPrice =
    parseTickerNumeric(ticker?.chips.find((c) => c.key === "gold")?.value) ??
    undefined
  const zecSupply = zecStats?.circulating ?? null
  const zecPrice = zecStats?.price ?? null

  const sections = buildSections({
    marketsResp: markets,
    goldPriceUsd: goldPrice,
    zecSupply,
    zecPrice,
  })

  return (
    <div className="max-w-3xl mx-auto py-2 md:py-6 flex flex-col gap-7 md:gap-10">
      {/* HEADLINE — sans-serif so it stands out from the monospace
          body. "worth" is the only word in cyph-green; everything else
          uses the default text color (white-ish). */}
      <header className="flex flex-col">
        <h1
          className="font-sans font-bold tracking-tight leading-[1.05]"
          style={{
            color: paletteVar("text"),
            fontSize: "clamp(2.5rem, 8.5vw, 4.75rem)",
          }}
        >
          What ZEC could
          <br />
          be{" "}
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
        <p
          className="text-[10px] md:text-[11px] tracking-[0.25em] mt-5 md:mt-6"
          style={{ color: paletteVar("cyph") }}
        >
          // IF ZEC CAPTURES A FRACTION OF EACH MARKET
        </p>
      </header>

      {/* COLUMN HEADERS — render once above the first market so the eye
          maps share/price/× to each row below without per-section
          repetition. Negative bottom margin pulls the first market's
          name closer so the headers feel attached to the table. */}
      <div
        className="grid grid-cols-[1fr_1fr_3.5rem] md:grid-cols-[1fr_1fr_5rem] gap-x-4 md:gap-x-8 text-[9px] md:text-[10px] tracking-[0.25em] -mb-4 md:-mb-6"
        style={{ color: paletteVar("text"), opacity: 0.45 }}
      >
        <span>SHARE</span>
        <span className="text-right">ZEC PRICE</span>
        <span className="text-right">×</span>
      </div>

      {/* MARKETS — each section is its own block; vertical rhythm is
          driven by the parent gap so all five blocks sit at identical
          spacing without ad-hoc margins. */}
      {sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}

      {/* FOOTER — snapshot timestamp + ZEC price on the left, the
          cypherpunk "logo" mark on the right (a thin LED-style square
          to echo the brand chip in the top-right of the mockup). */}
      <footer
        className="flex items-center justify-between mt-2 md:mt-4 pt-3 border-t text-[10px] tracking-[0.15em]"
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
    <section className="flex flex-col gap-3">
      {/* Section header: large sans-serif name on the left + compact
          market cap on the right. Underline divider matches the
          column-headers separator above for visual continuity. */}
      <div
        className="flex items-baseline justify-between gap-3 pb-2 border-b"
        style={{ borderColor: paletteVar("text") + "22" }}
      >
        <h2
          className="font-sans font-bold leading-none"
          style={{
            color: paletteVar("text"),
            fontSize: "clamp(1.375rem, 4vw, 2rem)",
            letterSpacing: "-0.01em",
          }}
        >
          {section.name}
        </h2>
        <span
          className="tabular-nums text-[12px] md:text-[14px] shrink-0"
          style={{ color: paletteVar("text"), opacity: 0.45 }}
        >
          {section.mcap != null ? fmtCompactUSD(section.mcap) : (
            <Skeleton style={{ width: 56, height: 12 }} />
          )}
        </span>
      </div>
      {/* Rows: SHARE (left) · ZEC PRICE (right-aligned mid) · × (right).
          Indent slightly on desktop so rows sit "under" the section
          name visually. */}
      <div className="flex flex-col gap-2 md:gap-2.5 md:pl-2">
        {section.rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_3.5rem] md:grid-cols-[1fr_1fr_5rem] gap-x-4 md:gap-x-8 text-[13px] md:text-[15px] tabular-nums items-baseline"
          >
            <span style={{ color: paletteVar("text"), opacity: 0.75 }}>
              {row.label}
            </span>
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
