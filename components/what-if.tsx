"use client"

import useSWR from "swr"
import { Skeleton } from "./primitives"
import { paletteVar } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import type { MarketsResponse, ZecStatsResponse } from "./api-types"

// ──────────────────────────────────────────────────────────────────────
// "What ZEC could be worth" — six-market valuation table.
//
// For each market we render rows of {share, implied ZEC price, multiple}
// where the implied price is `(marketCap × share) / zecCirculatingSupply`
// and the multiple is `impliedPrice / currentZecPrice`. The Dogecoin row
// is a small twist: instead of "share of DOGE", we phrase it as "ZEC
// trades at N× DOGE's market cap" because that frames the comparison
// the way crypto Twitter actually argues about it.
//
// Data sources:
//   • /api/markets         — BTC + DOGE + stablecoin issuers, live every
//                            5 min via SWR; KV-cached at the CF edge.
//   • /api/zec-stats       — ZEC circulating supply + current spot price.
//   • /api/gold-price      — gold spot, with /api/ticker as primary +
//                            a long-lived KV stash as fallback so the
//                            section never falls back to the stale
//                            $4,200 constant unless KV is also empty.
//   • /api/static-markets  — offshore wealth, global GDP, gold supply.
//                            Backed by public/data/static-markets.json
//                            for slow-moving reference figures.
//
// AS OF badges per section follow a pattern:
//   • Bitcoin / Dogecoin   — no badge (live + frequent).
//   • Stablecoins          — current YYYY-MM (live but slow-moving;
//                            badge sets the "this is a recent figure"
//                            expectation).
//   • Gold                 — YYYY-MM from /api/gold-price.asOf, which
//                            reflects when the price was actually
//                            fetched (live, stash, or static).
//   • Offshore + Global    — YYYY-MM from the static JSON, since neither
//                            has a clean live source.
//
// Layout: each row is a 3-column inline-style grid (share | price |
// multiple) so the column template works in Tailwind v4 without
// arbitrary-value parsing quirks. Section blocks share a parent gap so
// vertical rhythm stays consistent without per-section margins.
// ──────────────────────────────────────────────────────────────────────

/** Mirror of /api/static-markets's response shape. Defined locally
 *  rather than imported from api-types.ts because this is the only
 *  caller — keeps that shared types module focused on the multi-
 *  consumer endpoints. */
interface StaticMarketsResponse {
  offshoreWealth: { usd: number; asOf: string; source: string; sourceUrl?: string }
  globalEconomy: { usd: number; asOf: string; source: string; sourceUrl?: string }
  goldSupply: { troyOz: number; asOf: string; source: string; sourceUrl?: string }
  goldPriceFallbackUsd: { value: number; asOf: string; source: string; sourceUrl?: string }
}

/** Mirror of /api/gold-price's response shape. */
interface GoldPriceResponse {
  priceUsd: number
  asOf: string
  source: "live" | "stash" | "static"
  fetchedAt: number
}

/** Last-resort fallback if /api/static-markets is unreachable. Matches
 *  the bundled JSON so the page math is consistent either way. */
const STATIC_MARKETS_FALLBACK: StaticMarketsResponse = {
  offshoreWealth: { usd: 11.3e12, asOf: "2024-06", source: "fallback" },
  globalEconomy: { usd: 110e12, asOf: "2024-10", source: "fallback" },
  goldSupply: { troyOz: 7.5e9, asOf: "2024-12", source: "fallback" },
  goldPriceFallbackUsd: { value: 4200, asOf: "2026-05", source: "fallback" },
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
  /** True for the "now" reference row at the top of each section,
   *  which shows ZEC's current share of the market + current spot.
   *  Rendered with dimmer styling so it reads as context rather than
   *  competing with the aspirational scenario rows below. */
  isCurrent?: boolean
}

interface MarketBlock {
  key: string
  name: string
  /** Live market cap in USD. Null while loading; used for the right-
   *  aligned reference value next to each section heading. */
  mcap: number | null
  /** Optional "AS OF YYYY-MM" badge rendered next to the market cap.
   *  Conventions:
   *   - Static-source sections (offshore, global economy) → the date
   *     the source figure was published.
   *   - Gold → /api/gold-price's `asOf`, which reflects whether we got
   *     the price live, from the KV stash, or from the static fallback.
   *   - Stablecoins → current YYYY-MM (live but slow-moving, so the
   *     "recent" framing helps set expectations).
   *   - BTC / DOGE → no badge (live + frequent enough that a date
   *     would be noisier than useful). */
  note?: string
  rows: ScenarioRow[]
}

interface BuildCtx {
  marketsResp?: MarketsResponse
  goldPriceUsd: number
  goldAsOf: string
  goldTroyOz: number
  offshoreWealthUsd: number
  offshoreWealthAsOf: string
  globalEconomyUsd: number
  globalEconomyAsOf: string
  stablecoinsAsOf: string
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

/** Format a small share % more precisely for the "now" reference row.
 *  The scenario rows use rounded percentages (1%, 0.5%) because the
 *  share IS the scenario — but ZEC's CURRENT share of a giant market
 *  is often well below 1% (e.g. 0.7% of BTC, 0.099% of offshore
 *  wealth), so we need higher precision for that row to read
 *  meaningfully. */
function fmtCurrentSharePct(share: number): string {
  const pct = share * 100
  if (pct >= 10) return `${pct.toFixed(1)}%`
  if (pct >= 1) return `${pct.toFixed(2)}%`
  if (pct >= 0.1) return `${pct.toFixed(2)}%`
  return `${pct.toFixed(3)}%`
}

/** "now" reference row for a share-mode section: shows ZEC's current
 *  share of the target market + the live ZEC spot. By construction
 *  the multiplier is always 1.0× (we're at "current" by definition).
 *  This row visibly updates as ZEC price moves — the share % is
 *  `(zecPrice × zecSupply) / marketMcap`, which is the dynamic
 *  indicator the user was missing on static-source sections like
 *  offshore wealth. */
function currentShareRow(
  marketMcap: number | null,
  zecSupply: number | null,
  zecPrice: number | null
): ScenarioRow {
  const zecMcap =
    zecSupply != null && zecPrice != null ? zecPrice * zecSupply : null
  const share =
    zecMcap != null && marketMcap != null && marketMcap > 0
      ? zecMcap / marketMcap
      : null
  return {
    label: share != null ? `now ${fmtCurrentSharePct(share)}` : "now",
    zecPrice,
    multiple: zecPrice != null ? 1.0 : null,
    isCurrent: true,
  }
}

/** "now" reference row for the Dogecoin mult-mode section: shows
 *  ZEC's current mcap relative to DOGE's as a multiplier (e.g. "now
 *  0.7× DOGE" when ZEC is at 70% of DOGE). Same semantics as the
 *  share-mode version but framed in the multiplier language Dogecoin
 *  uses. */
function currentDogeRow(
  dogeMcap: number | null,
  zecSupply: number | null,
  zecPrice: number | null
): ScenarioRow {
  const zecMcap =
    zecSupply != null && zecPrice != null ? zecPrice * zecSupply : null
  const mult =
    zecMcap != null && dogeMcap != null && dogeMcap > 0
      ? zecMcap / dogeMcap
      : null
  return {
    label: mult != null ? `now ${mult.toFixed(2)}× DOGE` : "now",
    zecPrice,
    multiple: zecPrice != null ? 1.0 : null,
    isCurrent: true,
  }
}

function buildSections(ctx: BuildCtx): MarketBlock[] {
  const {
    marketsResp,
    goldPriceUsd,
    goldAsOf,
    goldTroyOz,
    offshoreWealthUsd,
    offshoreWealthAsOf,
    globalEconomyUsd,
    globalEconomyAsOf,
    stablecoinsAsOf,
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
      // No AS OF — BTC mcap is live every 5 min via /api/markets.
      rows: [
        currentShareRow(btcMcap, zecSupply, zecPrice),
        ...[0.01, 0.02, 0.05, 0.1].map((s) =>
          computeShareRow(btcMcap, s, zecSupply, zecPrice, fmtSharePct)
        ),
      ],
    },
    {
      key: "offshore",
      name: "Offshore wealth",
      mcap: offshoreWealthUsd,
      // Annual research figure (BCG Global Wealth Report) — surface
      // the publication date so the reader knows the figure isn't live.
      note: `AS OF ${offshoreWealthAsOf}`,
      rows: [
        currentShareRow(offshoreWealthUsd, zecSupply, zecPrice),
        ...[0.001, 0.005, 0.01].map((s) =>
          computeShareRow(offshoreWealthUsd, s, zecSupply, zecPrice, fmtSharePct)
        ),
      ],
    },
    {
      key: "globalEconomy",
      name: "Global economy",
      mcap: globalEconomyUsd,
      // Annual research figure (IMF World Economic Outlook) — same
      // semantics as offshore wealth. Share tiers are smaller than
      // the other sections because the denominator ($110T) is huge:
      // even 0.1% lands ZEC at ~10× current price, and 1% is already
      // a ~100× scenario. Tiers picked to span 5× → 100× so the row
      // multipliers stay in the same magnitude band as the other
      // sections instead of blowing out to four digits.
      note: `AS OF ${globalEconomyAsOf}`,
      rows: [
        currentShareRow(globalEconomyUsd, zecSupply, zecPrice),
        ...[0.0005, 0.001, 0.005, 0.01].map((s) =>
          computeShareRow(globalEconomyUsd, s, zecSupply, zecPrice, fmtSharePct)
        ),
      ],
    },
    {
      key: "gold",
      name: "Gold",
      mcap: goldMcap,
      // AS OF comes from /api/gold-price, which reflects whether the
      // price came live from Yahoo, from the KV last-known-good stash,
      // or from the static fallback. The supply (oz) is also static
      // but moves <1%/year so the spot's asOf is the more meaningful
      // freshness signal.
      note: `AS OF ${goldAsOf}`,
      rows: [
        currentShareRow(goldMcap, zecSupply, zecPrice),
        ...[0.0005, 0.001, 0.005].map((s) =>
          computeShareRow(goldMcap, s, zecSupply, zecPrice, fmtSharePct)
        ),
      ],
    },
    {
      key: "stables",
      name: "Stablecoins",
      mcap: stablesMcap,
      // Stablecoin mcap is live (summed from /api/markets) but the
      // overall stablecoin float moves slowly enough that an AS OF
      // current-month badge is more useful than the bare number — it
      // signals "this is the current snapshot" without overpromising
      // intraday precision.
      note: `AS OF ${stablecoinsAsOf}`,
      rows: [
        currentShareRow(stablesMcap, zecSupply, zecPrice),
        ...[0.05, 0.1, 0.25].map((s) =>
          computeShareRow(stablesMcap, s, zecSupply, zecPrice, fmtSharePct)
        ),
      ],
    },
    {
      key: "doge",
      name: "Dogecoin",
      mcap: dogeMcap,
      // No AS OF — DOGE mcap is live every 5 min like BTC.
      rows: [
        currentDogeRow(dogeMcap, zecSupply, zecPrice),
        ...[1, 2, 5].map((m) =>
          computeMultRow(
            dogeMcap,
            m,
            zecSupply,
            zecPrice,
            m === 1 ? "= DOGE" : `${m}× DOGE`
          )
        ),
      ],
    },
  ]
}

function fmtImpliedPrice(p: number): string {
  return "$" + Math.round(p).toLocaleString("en-US")
}

function fmtMultiple(m: number): string {
  return `${m.toFixed(1)}×`
}

/** Current YYYY-MM in the user's local timezone. Used by the AS OF
 *  badges on live-but-slow-moving sections (stablecoins). Computed
 *  once per render — re-runs on each refresh anyway when SWR
 *  invalidates, so locking to a constant date isn't necessary. */
function currentYearMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
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
  // /api/gold-price wraps /api/ticker with a long-lived KV stash so the
  // gold section never falls back to the stale $4,200 constant unless
  // both upstream + KV are unavailable.
  const { data: goldPrice } = useSWR<GoldPriceResponse>(
    "/api/gold-price",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // Static (=no live API) reference values served via our own endpoint
  // so a JSON-only commit can refresh them without a code change.
  const { data: staticMarketsResp } = useSWR<StaticMarketsResponse>(
    "/api/static-markets",
    swrFetcher,
    { refreshInterval: 60 * 60_000, keepPreviousData: true }
  )
  const staticMarkets = staticMarketsResp ?? STATIC_MARKETS_FALLBACK

  // Gold pricing: prefer the dedicated endpoint's value + asOf so the
  // KV stash backs us up on any /api/ticker hiccup. Fall back to the
  // static-markets endpoint's constant + static asOf if /api/gold-price
  // itself is unreachable (true belt-and-suspenders).
  const goldPriceUsd =
    goldPrice?.priceUsd ?? staticMarkets.goldPriceFallbackUsd.value
  const goldAsOf =
    goldPrice?.asOf ?? staticMarkets.goldPriceFallbackUsd.asOf

  const zecSupply = zecStats?.circulating ?? null
  const zecPrice = zecStats?.price ?? null

  const sections = buildSections({
    marketsResp: markets,
    goldPriceUsd,
    goldAsOf,
    goldTroyOz: staticMarkets.goldSupply.troyOz,
    offshoreWealthUsd: staticMarkets.offshoreWealth.usd,
    offshoreWealthAsOf: staticMarkets.offshoreWealth.asOf,
    globalEconomyUsd: staticMarkets.globalEconomy.usd,
    globalEconomyAsOf: staticMarkets.globalEconomy.asOf,
    stablecoinsAsOf: currentYearMonth(),
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

      {/* MARKETS — six sections, identical structure. Parent gap drives
          vertical rhythm so we don't fight per-section margins. */}
      {sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}

      {/* FOOTER — live ZEC price on the left, "updated daily" note on
          the right. The underlying market caps + spot prices actually
          refresh on shorter TTLs (5min SWR client-side, 10min KV at
          the edge), but a daily GitHub Actions warmer keeps every
          endpoint warm so the table is guaranteed at least one fresh
          fetch per day even when organic traffic is quiet. */}
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
        {section.rows.map((row, i) => {
          // The "now" reference row gets dimmer text + no bold on the
          // multiplier so the eye registers it as a baseline rather
          // than a scenario. It's the row that visibly moves with
          // live ZEC price; the scenarios below stay anchored to
          // target market shares.
          const isCurrent = row.isCurrent === true
          return (
            <div
              key={i}
              className="tabular-nums text-[13px] md:text-[15px]"
              style={ROW_GRID}
            >
              <span
                style={{
                  color: paletteVar("text"),
                  opacity: isCurrent ? 0.55 : 1,
                  fontStyle: isCurrent ? "italic" : "normal",
                }}
              >
                {row.label}
              </span>
              <span
                className="text-right"
                style={{
                  color: paletteVar("text"),
                  opacity: isCurrent ? 0.55 : 1,
                }}
              >
                {row.zecPrice != null ? (
                  fmtImpliedPrice(row.zecPrice)
                ) : (
                  <Skeleton style={{ width: 56, height: 12 }} />
                )}
              </span>
              <span
                className={isCurrent ? "text-right" : "text-right font-bold"}
                style={{
                  color: paletteVar("cyph"),
                  opacity: isCurrent ? 0.55 : 1,
                  // Big multipliers get a subtle glow — pulls the eye to
                  // the rows that would actually matter. The "now" row
                  // is always 1.0× so this is never active for it.
                  textShadow:
                    !isCurrent && row.multiple != null && row.multiple >= 10
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
          )
        })}
      </div>
    </section>
  )
}
