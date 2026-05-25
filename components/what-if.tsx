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
// Data sources (live = fetched every ~5 min via SWR + KV-cached at the
// CF edge + warmed daily by .github/workflows/refresh-cache.yml):
//   • /api/markets         — BTC + DOGE + stablecoin issuers (CMC + CoinPaprika)
//   • /api/zec-stats       — ZEC circulating supply + current spot
//   • /api/ticker          — gold spot price (Yahoo `GC=F`)
//   • /api/static-markets  — offshore wealth + above-ground gold supply
//                            + gold price fallback. Backed by
//                            public/data/static-markets.json; lacks a
//                            clean live API so updates happen via a
//                            JSON commit. Endpoint surfaces the `asOf`
//                            date so the UI can show review freshness.
//
// Layout: each row is a 3-column inline-style grid (share | price |
// multiple) so the column template works in Tailwind v4 without
// arbitrary-value parsing quirks. Section blocks share a parent gap so
// vertical rhythm stays consistent without per-section margins.
// ──────────────────────────────────────────────────────────────────────

interface TickerChip {
  key: string
  value: string
}
interface TickerResponse {
  chips: TickerChip[]
}

/** Mirror of /api/static-markets's response shape. Defined locally
 *  rather than imported from api-types.ts because this is the only
 *  caller — keeps that shared types module focused on the multi-
 *  consumer endpoints. */
interface StaticMarketsResponse {
  offshoreWealth: {
    usd: number
    asOf: string
    source: string
    sourceUrl?: string
  }
  goldSupply: {
    troyOz: number
    asOf: string
    source: string
    sourceUrl?: string
  }
  goldPriceFallbackUsd: {
    value: number
    asOf: string
    source: string
    sourceUrl?: string
  }
}

/** Last-resort fallback if /api/static-markets is unreachable. Matches
 *  the bundled JSON so the page math is consistent either way; lacking
 *  an `asOf` because the constant doesn't carry one. */
const STATIC_MARKETS_FALLBACK: StaticMarketsResponse = {
  offshoreWealth: { usd: 11.3e12, asOf: "2024-06", source: "fallback" },
  goldSupply: { troyOz: 7.5e9, asOf: "2024-12", source: "fallback" },
  goldPriceFallbackUsd: { value: 4200, asOf: "2026-05", source: "fallback" },
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
  goldTroyOz: number
  offshoreWealthUsd: number
  offshoreWealthAsOf: string
  goldSupplyAsOf: string
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
  const {
    marketsResp,
    goldPriceUsd,
    goldIsLive,
    goldTroyOz,
    offshoreWealthUsd,
    offshoreWealthAsOf,
    goldSupplyAsOf,
    zecSupply,
    zecPrice,
  } = ctx
  const btcMcap = findCoinMcap(marketsResp, "BTC")
  const dogeMcap = findCoinMcap(marketsResp, "DOGE")
  const goldMcap = goldPriceUsd * goldTroyOz
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
      mcap: offshoreWealthUsd,
      // Offshore wealth has no live API — surface the as-of date so
      // readers know how fresh the figure is. BCG's Global Wealth
      // Report is the canonical annual source.
      note: `AS OF ${offshoreWealthAsOf}`,
      rows: [0.001, 0.005, 0.01].map((s) =>
        computeShareRow(offshoreWealthUsd, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "gold",
      name: "Gold",
      mcap: goldMcap,
      // Two reasons to annotate this section:
      //   - Gold supply (oz) is a slow-moving static (annual review),
      //     so show the as-of for transparency.
      //   - When /api/ticker hasn't returned a live gold spot, we fall
      //     back to a stale price constant — flag that too so the user
      //     knows the implied prices are derived from an estimate.
      note: goldIsLive ? `AS OF ${goldSupplyAsOf}` : "EST.",
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
  // Static (=no live API) reference values served via our own endpoint
  // so a JSON-only commit can refresh them without a code change. The
  // fallback object below mirrors the bundled JSON, so the page still
  // renders consistently if /api/static-markets ever 5xxs.
  const { data: staticMarketsResp } = useSWR<StaticMarketsResponse>(
    "/api/static-markets",
    swrFetcher,
    { refreshInterval: 60 * 60_000, keepPreviousData: true }
  )
  const staticMarkets = staticMarketsResp ?? STATIC_MARKETS_FALLBACK

  const goldPriceLive = parseTickerNumeric(
    ticker?.chips.find((c) => c.key === "gold")?.value
  )
  const goldIsLive = goldPriceLive != null
  // Fall back to a recent gold spot so the section never blanks. The
  // implied prices are still informative even with a slightly stale
  // gold spot, and the section header flags the estimate.
  const goldPriceUsd =
    goldPriceLive ?? staticMarkets.goldPriceFallbackUsd.value

  const zecSupply = zecStats?.circulating ?? null
  const zecPrice = zecStats?.price ?? null

  const sections = buildSections({
    marketsResp: markets,
    goldPriceUsd,
    goldIsLive,
    goldTroyOz: staticMarkets.goldSupply.troyOz,
    offshoreWealthUsd: staticMarkets.offshoreWealth.usd,
    offshoreWealthAsOf: staticMarkets.offshoreWealth.asOf,
    goldSupplyAsOf: staticMarkets.goldSupply.asOf,
    zecSupply,
    zecPrice,
  })

  return (
    <div className="max-w-2xl mx-auto py-3 md:py-4 flex flex-col gap-6 md:gap-7">
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

      {/* FOOTER — live ZEC price on the left, "updated daily" note on
          the right. The underlying market caps + spot prices actually
          refresh on shorter TTLs (5min SWR client-side, 10min KV at
          the edge), but a daily Cloudflare cron warms the KV ceiling
          so the table is guaranteed at least one fresh fetch per day
          even when organic traffic is quiet. The note sets that
          expectation for the reader. */}
      <footer
        className="flex items-center justify-between mt-1 pt-3 border-t text-[10px] tracking-[0.2em]"
        style={{
          borderColor: paletteVar("text") + "22",
          color: paletteVar("cyph"),
        }}
      >
        <span style={{ opacity: 0.75 }}>
          {zecPrice != null ? (
            <>ZEC ${zecPrice.toFixed(2)}</>
          ) : (
            <span className="inline-flex items-center gap-1">
              ZEC <Skeleton style={{ width: 40, height: 10 }} />
            </span>
          )}
        </span>
        <span style={{ opacity: 0.5 }}>UPDATED DAILY</span>
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
        <div className="flex items-baseline gap-2.5 md:gap-3 shrink-0">
          {section.note && (
            <span
              className="text-[9px] tracking-[0.2em]"
              style={{ color: paletteVar("text"), opacity: 0.4 }}
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
      <div className="flex flex-col gap-2 md:gap-1.5">
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
