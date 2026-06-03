"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Skeleton } from "./primitives"
import { paletteVar } from "./theme"
import { fmtCompactUSD, swrFetcher } from "./format"
import { ShareButton } from "./share-button"
import type {
  MarketsResponse,
  PricesResponse,
  ZecStatsResponse,
} from "./api-types"

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
//   • /api/prices?days=7   — realtime ZEC spot, 60s tick. Same source the
//                            homepage dashboard uses, so the live "now"
//                            number on /what-if matches what users see
//                            on the front page within the same minute.
//   • /api/zec-stats       — ZEC circulating supply (5 min refresh); also
//                            used as the spot-price fallback when the
//                            tick endpoint is briefly unavailable.
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

/** Mirror of /api/stablecoins-total's response shape. Sourced from
 *  DefiLlama; covers the full stablecoin universe rather than the
 *  top-5 issuers we'd otherwise sum from CMC. */
interface StablecoinsTotalResponse {
  totalUsd: number
  asOf: string
  asOfDate: string
  source: "defillama" | "stash"
  fetchedAt: number
}

type BtcBasis = "mcap" | "price"

/** Last-resort fallback if /api/static-markets is unreachable. Matches
 *  the bundled JSON so the page math is consistent either way. */
const STATIC_MARKETS_FALLBACK: StaticMarketsResponse = {
  offshoreWealth: { usd: 14.4e12, asOf: "2025-06", source: "fallback" },
  globalEconomy: { usd: 123e12, asOf: "2026-04", source: "fallback" },
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
  spot?: string
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
  /** Live stablecoin total in USD. Sourced from DefiLlama via
   *  /api/stablecoins-total when available; falls back to the
   *  CMC-summed value when the endpoint 503s. Null while loading. */
  stablecoinsUsd: number | null
  stablecoinsAsOf: string
  zecSupply: number | null
  zecPrice: number | null
  btcBasis: BtcBasis
}

function findCoinMcap(
  markets: MarketsResponse | undefined,
  symbol: string
): number | null {
  return markets?.coins.find((c) => c.symbol === symbol)?.marketCap ?? null
}

function findCoinPrice(
  markets: MarketsResponse | undefined,
  symbol: string
): number | null {
  return markets?.coins.find((c) => c.symbol === symbol)?.price ?? null
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

function computePriceShareRow(
  basePrice: number | null,
  share: number,
  zecPrice: number | null,
  fmtShare: (s: number) => string
): ScenarioRow {
  const zp =
    basePrice != null && Number.isFinite(basePrice)
      ? basePrice * share
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
    goldAsOf,
    goldTroyOz,
    offshoreWealthUsd,
    offshoreWealthAsOf,
    globalEconomyUsd,
    globalEconomyAsOf,
    stablecoinsUsd,
    stablecoinsAsOf,
    zecSupply,
    zecPrice,
    btcBasis,
  } = ctx
  const btcMcap = findCoinMcap(marketsResp, "BTC")
  const btcPrice = findCoinPrice(marketsResp, "BTC")
  const dogeMcap = findCoinMcap(marketsResp, "DOGE")
  const dogePrice = findCoinPrice(marketsResp, "DOGE")
  const goldMcap = goldPriceUsd * goldTroyOz
  // Prefer the canonical DefiLlama total (covers PYUSD / USDS / smaller
  // issuers we'd miss summing top-5 from CMC). Fall back to the CMC
  // sum when /api/stablecoins-total is unreachable so the section
  // never blanks; that's why this is a chained nullish coalesce.
  const stablesMcap = stablecoinsUsd ?? computeStablecoinMcap(marketsResp)

  return [
    {
      key: "btc",
      name: "Bitcoin",
      mcap: btcMcap,
      note: btcBasis === "price" ? "PRICE BASIS" : "MCAP BASIS",
      spot: btcPrice != null ? `BTC ${fmtSpotPrice(btcPrice)}` : undefined,
      // No AS OF — BTC mcap is live every 5 min via /api/markets.
      rows: [0.01, 0.02, 0.05, 0.1].map((s) =>
        btcBasis === "price"
          ? computePriceShareRow(btcPrice, s, zecPrice, fmtSharePct)
          : computeShareRow(btcMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "offshore",
      name: "Offshore wealth",
      mcap: offshoreWealthUsd,
      // Annual research figure (BCG Global Wealth Report) — surface
      // the publication date so the reader knows the figure isn't live.
      note: `AS OF ${offshoreWealthAsOf}`,
      rows: [0.001, 0.005, 0.01].map((s) =>
        computeShareRow(offshoreWealthUsd, s, zecSupply, zecPrice, fmtSharePct)
      ),
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
      rows: [0.0005, 0.001, 0.005, 0.01].map((s) =>
        computeShareRow(globalEconomyUsd, s, zecSupply, zecPrice, fmtSharePct)
      ),
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
      rows: [0.0005, 0.001, 0.005].map((s) =>
        computeShareRow(goldMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
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
      rows: [0.05, 0.1, 0.25].map((s) =>
        computeShareRow(stablesMcap, s, zecSupply, zecPrice, fmtSharePct)
      ),
    },
    {
      key: "doge",
      name: "Dogecoin",
      mcap: dogeMcap,
      spot: dogePrice != null ? `DOGE ${fmtSpotPrice(dogePrice)}` : undefined,
      // No AS OF — DOGE mcap is live every 5 min like BTC.
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

function fmtSpotPrice(p: number): string {
  if (p >= 1000) {
    return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 })
  }
  if (p >= 1) return "$" + p.toFixed(2)
  return "$" + p.toFixed(4)
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
  const [btcBasis, setBtcBasisState] = useState<BtcBasis>("mcap")
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    setBtcBasisState(params.get("btcBasis") === "price" ? "price" : "mcap")
  }, [])
  const setBtcBasis = (next: BtcBasis) => {
    setBtcBasisState(next)
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (next === "price") {
      url.searchParams.set("btcBasis", "price")
    } else {
      url.searchParams.delete("btcBasis")
    }
    window.history.replaceState(null, "", url.toString())
  }
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
  // Always-on 60s tick subscription so the headline ZEC price + every
  // multiplier on the page move with the live spot, not the slower
  // /api/zec-stats cadence. Same key the homepage dashboard uses, so
  // SWR dedupes across surfaces — viewing the dashboard then jumping
  // here doesn't trigger an extra round-trip.
  const { data: pricesTick } = useSWR<PricesResponse>(
    "/api/prices?days=7",
    swrFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  // /api/gold-price wraps /api/ticker with a long-lived KV stash so the
  // gold section never falls back to the stale $4,200 constant unless
  // both upstream + KV are unavailable.
  const { data: goldPrice } = useSWR<GoldPriceResponse>(
    "/api/gold-price",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // /api/stablecoins-total wraps DefiLlama's full-universe total so the
  // stablecoin section reflects PYUSD + USDS + smaller issuers we'd
  // otherwise miss summing top-5 from CMC. Stable totals move slowly
  // so we refresh hourly client-side; the server caches in KV with a
  // 1h fresh TTL too.
  const { data: stablecoinsTotal } = useSWR<StablecoinsTotalResponse>(
    "/api/stablecoins-total",
    swrFetcher,
    { refreshInterval: 60 * 60_000, keepPreviousData: true }
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
  // Prefer the 60s tick (/api/prices?days=7) so the live spot here
  // matches the homepage within one refresh cycle. Fall back to
  // /api/zec-stats.price while the tick is loading or briefly errors.
  const zecPrice =
    pricesTick?.current?.zec?.price ?? zecStats?.price ?? null

  const sections = buildSections({
    marketsResp: markets,
    goldPriceUsd,
    goldAsOf,
    goldTroyOz: staticMarkets.goldSupply.troyOz,
    offshoreWealthUsd: staticMarkets.offshoreWealth.usd,
    offshoreWealthAsOf: staticMarkets.offshoreWealth.asOf,
    globalEconomyUsd: staticMarkets.globalEconomy.usd,
    globalEconomyAsOf: staticMarkets.globalEconomy.asOf,
    // DefiLlama-sourced when /api/stablecoins-total returned 200;
    // null otherwise so buildSections can fall back to the CMC sum.
    // AS OF reflects the DefiLlama snapshot date when available; the
    // current month is a fine fallback for the CMC-sum path since
    // CMC data is live anyway.
    stablecoinsUsd: stablecoinsTotal?.totalUsd ?? null,
    stablecoinsAsOf: stablecoinsTotal?.asOf ?? currentYearMonth(),
    zecSupply,
    zecPrice,
    btcBasis,
  })

  const zecMcap =
    zecPrice != null && zecSupply != null ? zecPrice * zecSupply : null
  const whatIfShareUrl =
    btcBasis === "price"
      ? "https://cyphzec.com/what-if?btcBasis=price"
      : "https://cyphzec.com/what-if"
  const whatIfOgImagePath = `/api/og/what-if?btcBasis=${btcBasis}`

  return (
    <div className="max-w-2xl mx-auto py-2 md:py-4 flex flex-col gap-3 md:gap-4">
      {/* HEADER — H1 + ShareButton on the same row; a compact NOW strip
          right below the H1 holds ZEC's live spot + mcap, replacing the
          per-section "now" baseline rows so the six sections fit one
          mobile viewport. */}
      <div className="flex items-start justify-between gap-3">
        <h1
          className="font-sans font-bold tracking-tight leading-[1.05]"
          style={{
            color: paletteVar("text"),
            fontSize: "clamp(1.625rem, 4.6vw, 2.625rem)",
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
        <ShareButton
          tweetText="What ZEC could be worth — implied price scenarios across BTC, gold, stablecoins, and more:"
          ogImagePath={whatIfOgImagePath}
          pngFileName="what-zec-could-be-worth.png"
          shareUrl={whatIfShareUrl}
          xCacheBust
          ariaLabel="Share this page"
        />
      </div>
      <NowBar zecPrice={zecPrice} zecMcap={zecMcap} />

      {/* MARKETS — six sections, identical structure. Parent gap drives
          vertical rhythm so we don't fight per-section margins. Tight
          gap on mobile so all six fit one viewport without scroll. */}
      <div className="flex flex-col gap-3 md:gap-5 mt-1 md:mt-2">
        {sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            btcBasis={btcBasis}
            onBtcBasisChange={setBtcBasis}
          />
        ))}
      </div>

      {/* FOOTER — UPDATED DAILY note. ZEC's spot lives in the NowBar
          above, so we drop the duplicate price reading here. */}
      <footer
        className="flex items-center justify-end mt-1 pt-3 border-t text-[10px] tracking-[0.2em]"
        style={{
          borderColor: paletteVar("text") + "22",
          color: paletteVar("cyph"),
        }}
      >
        <span style={{ opacity: 0.5 }}>UPDATED DAILY</span>
      </footer>
    </div>
  )
}

function BtcBasisToggle({
  value,
  onChange,
}: {
  value: BtcBasis
  onChange: (basis: BtcBasis) => void
}) {
  const options: { value: BtcBasis; label: string; title: string }[] = [
    { value: "mcap", label: "MCAP", title: "Compare by Bitcoin market cap" },
    { value: "price", label: "PRICE", title: "Compare by Bitcoin spot price" },
  ]
  return (
    <div
      className="inline-flex items-center border text-[8px] tracking-[0.16em] shrink-0"
      style={{ borderColor: `${paletteVar("cyph")}44` }}
      aria-label="Bitcoin comparison basis"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className="px-1.5 py-0.5 font-bold transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: active ? "#000" : paletteVar("cyph"),
              background: active ? paletteVar("cyph") : "transparent",
              outlineColor: paletteVar("cyph"),
              opacity: active ? 1 : 0.7,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function Section({
  section,
  btcBasis,
  onBtcBasisChange,
}: {
  section: MarketBlock
  btcBasis: BtcBasis
  onBtcBasisChange: (basis: BtcBasis) => void
}) {
  return (
    <section className="flex flex-col gap-1.5 md:gap-2">
      {/* Section header: sans-serif name on the left + compact market
          cap on the right. Underline divider sits flush with the
          header so the rows below feel attached. */}
      <div
        className="flex items-start justify-between gap-3 pb-1 border-b"
        style={{ borderColor: paletteVar("text") + "22" }}
      >
        <div className="flex items-center gap-2 min-w-0">
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
          {section.key === "btc" && (
            <BtcBasisToggle value={btcBasis} onChange={onBtcBasisChange} />
          )}
        </div>
        <div className="flex flex-wrap items-baseline justify-end gap-x-2.5 gap-y-1 md:gap-x-3 shrink-0">
          {section.note && (
            <span
              className="text-[9px] tracking-[0.2em]"
              style={{ color: paletteVar("text"), opacity: 0.4 }}
            >
              {section.note.toUpperCase()}
            </span>
          )}
          {section.spot && (
            <span
              className="text-[9px] tracking-[0.16em] tabular-nums"
              style={{ color: paletteVar("cyph"), opacity: 0.75 }}
            >
              {section.spot}
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
      <div className="flex flex-col gap-1 md:gap-1.5">
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
                // Big multipliers get a subtle glow — pulls the eye
                // to the rows that would actually matter.
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

// ──────────────────────────────────────────────────────────────────────
// Top "NOW" strip + ShareButton — replaces the per-section "now" reference
// row so the table fits one mobile screen. The strip shows ZEC's live
// spot + mcap; the share button gives the user a one-click Copy-link or
// Share-to-X path. Both sit on the same flex row as the H1 so they don't
// add a separate strip of vertical space.
// ──────────────────────────────────────────────────────────────────────

function NowBar({
  zecPrice,
  zecMcap,
}: {
  zecPrice: number | null
  zecMcap: number | null
}) {
  // Subtle uppercase strip — same tracking/sizing as the AS OF badges
  // so it reads as "page-level context" rather than a data row.
  return (
    <div
      className="flex items-baseline gap-2 text-[10px] md:text-[11px] tracking-[0.2em] tabular-nums"
      style={{ color: paletteVar("cyph") }}
    >
      <span style={{ opacity: 0.55 }}>NOW</span>
      <span style={{ opacity: 0.9 }}>
        {zecPrice != null ? (
          <>ZEC ${zecPrice.toFixed(2)}</>
        ) : (
          <Skeleton style={{ width: 56, height: 10 }} />
        )}
      </span>
      <span style={{ opacity: 0.45 }}>·</span>
      <span style={{ color: paletteVar("text"), opacity: 0.55 }}>
        MCAP{" "}
        {zecMcap != null ? (
          fmtCompactUSD(zecMcap)
        ) : (
          <Skeleton style={{ width: 40, height: 10 }} />
        )}
      </span>
    </div>
  )
}

