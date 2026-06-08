import { ImageResponse } from "next/og"
import {
  isPositiveNumber,
  missingOgDataResponse,
  ogHeaders,
  wantsCompleteOgImage,
} from "@/lib/og-complete"

// 1200x630 OG snapshot of the /what-if valuation table. Same data
// sources as the page itself (markets / zec-stats / gold-price /
// stablecoins-total / static-markets), so the image always reflects
// the same numbers the live page shows when the OG was minted.
//
// Cache-Control sits at s-maxage=3600 + 24h stale-while-revalidate
// — paired with the page metadata's hourly `?h=YYYYMMDDHH` cache
// buster (see app/what-if/page.tsx), Twitter / Facebook see a new
// URL each hour and re-crawl, so the OG embed refreshes hourly on
// socials even though our CF edge serves a cached PNG within each
// hour bucket.
//
// No `runtime = "edge"` export — on OpenNext for Cloudflare every
// route already runs on workerd. Declaring the edge runtime would
// force this route into a separate function bundle.

// ── Type subsets of the upstream endpoints — kept narrow so a future
//    upstream change can't accidentally crash the OG render. ─────────
interface ZecStatsLite {
  circulating: number | null
  price: number | null
}
interface PricesLite {
  current?: { zec?: { price?: number | null } }
}
interface MarketsLite {
  coins: {
    symbol: string
    marketCap: number | null
    price?: number | null
    circulatingSupply?: number | null
  }[]
}
interface GoldPriceLite {
  priceUsd: number
}
interface StablesLite {
  totalUsd: number
}
interface StaticMarketsLite {
  offshoreWealth: { usd: number }
  globalEconomy: { usd: number }
  goldSupply: { troyOz: number }
  goldPriceFallbackUsd: { value: number }
}

interface WhatIfSnapshotLite {
  markets: MarketsLite | null
  zecStats: ZecStatsLite | null
  pricesTick: PricesLite | null
  goldPrice: GoldPriceLite | null
  stablecoinsTotal: StablesLite | null
  staticMarkets: StaticMarketsLite
  complete: boolean
}

interface Snapshot {
  zecPrice: number | null
  zecSupply: number | null
  btcMcap: number | null
  btcPrice: number | null
  dogeMcap: number | null
  dogePrice: number | null
  goldMcap: number | null
  stablesMcap: number | null
  offshoreMcap: number
  globalEconomyMcap: number
}

async function fetchSnapshot(origin: string): Promise<Snapshot> {
  const noStore = { cache: "no-store" as const }

  // Reasonable static fallbacks so the OG never blanks even when every
  // upstream call fails. Numbers match the bundled JSON / live-source
  // defaults so the OG and the live page round-trip to similar values.
  let zecPrice: number | null = null
  let zecSupply: number | null = null
  let btcMcap: number | null = null
  let btcPrice: number | null = null
  let dogeMcap: number | null = null
  let dogePrice: number | null = null
  let goldPriceUsd = 4200
  let goldTroyOz = 7.5e9
  let stablesMcap: number | null = null
  let offshoreMcap = 14.4e12
  let globalEconomyMcap = 123e12

  const snapshotRes = await fetch(`${origin}/api/what-if-snapshot`, noStore)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
  const cached = snapshotRes as WhatIfSnapshotLite | null
  if (cached?.complete) {
    const zecCoin = cached.markets?.coins.find((c) => c.symbol === "ZEC")
    const btc = cached.markets?.coins.find((c) => c.symbol === "BTC")
    const doge = cached.markets?.coins.find((c) => c.symbol === "DOGE")
    const cachedZecPrice =
      cached.pricesTick?.current?.zec?.price ??
      cached.zecStats?.price ??
      zecCoin?.price ??
      null
    const cachedZecSupply =
      cached.zecStats?.circulating ?? zecCoin?.circulatingSupply ?? null
    const cachedGoldPrice =
      cached.goldPrice?.priceUsd ??
      cached.staticMarkets.goldPriceFallbackUsd.value
    return {
      zecPrice: cachedZecPrice,
      zecSupply: cachedZecSupply,
      btcMcap: btc?.marketCap ?? null,
      btcPrice: btc?.price ?? null,
      dogeMcap: doge?.marketCap ?? null,
      dogePrice: doge?.price ?? null,
      goldMcap: cachedGoldPrice * cached.staticMarkets.goldSupply.troyOz,
      stablesMcap:
        cached.stablecoinsTotal?.totalUsd ??
        computeStablecoinMcap(cached.markets),
      offshoreMcap: cached.staticMarkets.offshoreWealth.usd,
      globalEconomyMcap: cached.staticMarkets.globalEconomy.usd,
    }
  }

  // /api/prices?days=7 is the same 60s tick the homepage uses for
  // live ZEC pricing. Fetched in parallel with the other endpoints
  // so the OG render reflects the spot from the same source as the
  // page itself, not the slower /api/zec-stats cadence. Supply still
  // comes from /api/zec-stats since prices doesn't expose it.
  const [zec, markets, gold, stables, statics, prices] =
    await Promise.allSettled([
      fetch(`${origin}/api/zec-stats`, noStore),
      fetch(`${origin}/api/markets`, noStore),
      fetch(`${origin}/api/gold-price`, noStore),
      fetch(`${origin}/api/stablecoins-total`, noStore),
      fetch(`${origin}/api/static-markets`, noStore),
      fetch(`${origin}/api/prices?days=7`, noStore),
    ])

  if (zec.status === "fulfilled" && zec.value.ok) {
    const d = (await zec.value.json()) as ZecStatsLite
    zecPrice = d?.price ?? null
    zecSupply = d?.circulating ?? null
  }
  // Override zecPrice with the live tick value when available — same
  // precedence the client component uses (prices.current.zec.price
  // wins over zec-stats.price).
  if (prices.status === "fulfilled" && prices.value.ok) {
    const d = (await prices.value.json()) as PricesLite
    const live = d?.current?.zec?.price
    if (typeof live === "number" && live > 0) {
      zecPrice = live
    }
  }
  if (markets.status === "fulfilled" && markets.value.ok) {
    const d = (await markets.value.json()) as MarketsLite
    const btc = d?.coins?.find((c) => c.symbol === "BTC")
    const doge = d?.coins?.find((c) => c.symbol === "DOGE")
    btcMcap = btc?.marketCap ?? null
    btcPrice = btc?.price ?? null
    dogeMcap = doge?.marketCap ?? null
    dogePrice = doge?.price ?? null
    stablesMcap = computeStablecoinMcap(d)
  }
  if (gold.status === "fulfilled" && gold.value.ok) {
    const d = (await gold.value.json()) as GoldPriceLite
    if (d?.priceUsd && d.priceUsd > 0) goldPriceUsd = d.priceUsd
  }
  if (stables.status === "fulfilled" && stables.value.ok) {
    const d = (await stables.value.json()) as StablesLite
    if (d?.totalUsd && d.totalUsd > 0) stablesMcap = d.totalUsd
  }
  if (statics.status === "fulfilled" && statics.value.ok) {
    const d = (await statics.value.json()) as StaticMarketsLite
    if (d?.offshoreWealth?.usd) offshoreMcap = d.offshoreWealth.usd
    if (d?.globalEconomy?.usd) globalEconomyMcap = d.globalEconomy.usd
    if (d?.goldSupply?.troyOz) goldTroyOz = d.goldSupply.troyOz
    if (
      stablesMcap == null &&
      d?.goldPriceFallbackUsd?.value &&
      !(gold.status === "fulfilled" && gold.value.ok)
    ) {
      goldPriceUsd = d.goldPriceFallbackUsd.value
    }
  }

  return {
    zecPrice,
    zecSupply,
    btcMcap,
    btcPrice,
    dogeMcap,
    dogePrice,
    goldMcap: goldPriceUsd * goldTroyOz,
    stablesMcap,
    offshoreMcap,
    globalEconomyMcap,
  }
}

function computeStablecoinMcap(markets: MarketsLite | null): number | null {
  if (!markets) return null
  const stables = ["USDT", "USDC", "DAI", "BUSD", "FDUSD", "USDe", "TUSD"]
  let sum = 0
  let hasUsdt = false
  for (const sym of stables) {
    const coin = markets.coins.find((c) => c.symbol === sym)
    if (coin?.marketCap != null) {
      sum += coin.marketCap
      if (sym === "USDT") hasUsdt = true
    }
  }
  return hasUsdt ? sum : null
}

function missingSnapshotFields(s: Snapshot): string[] {
  const required: Array<[keyof Snapshot, unknown]> = [
    ["zecPrice", s.zecPrice],
    ["zecSupply", s.zecSupply],
    ["btcMcap", s.btcMcap],
    ["btcPrice", s.btcPrice],
    ["dogeMcap", s.dogeMcap],
    ["dogePrice", s.dogePrice],
    ["goldMcap", s.goldMcap],
    ["stablesMcap", s.stablesMcap],
    ["offshoreMcap", s.offshoreMcap],
    ["globalEconomyMcap", s.globalEconomyMcap],
  ]
  return required
    .filter(([, value]) => !isPositiveNumber(value))
    .map(([name]) => name)
}

function fmtImpliedPrice(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "—"
  return "$" + Math.round(p).toLocaleString("en-US")
}
function fmtMultiple(m: number | null): string {
  if (m == null || !Number.isFinite(m)) return "—"
  return `${m.toFixed(1)}×`
}
function fmtMcap(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtSpot(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}

// Compute one scenario row's {implied price, multiplier} given the
// target market cap + share + ZEC's live supply + price.
function row(
  mcap: number | null,
  share: number,
  supply: number | null,
  price: number | null
): { price: string; mult: string } {
  if (
    mcap == null ||
    supply == null ||
    supply <= 0 ||
    !Number.isFinite(mcap)
  ) {
    return { price: "—", mult: "—" }
  }
  const zp = (mcap * share) / supply
  const mult = price != null && price > 0 ? zp / price : null
  return { price: fmtImpliedPrice(zp), mult: fmtMultiple(mult) }
}

function priceRow(
  basePrice: number | null,
  share: number,
  price: number | null
): { price: string; mult: string } {
  if (basePrice == null || !Number.isFinite(basePrice)) {
    return { price: "—", mult: "—" }
  }
  const zp = basePrice * share
  const mult = price != null && price > 0 ? zp / price : null
  return { price: fmtImpliedPrice(zp), mult: fmtMultiple(mult) }
}

// Dogecoin uses multiplier-mode framing: "= DOGE" / "2× DOGE" /
// "5× DOGE" rather than share percentages, to match the live page.
function dogeRow(
  dogeMcap: number | null,
  mult: number,
  supply: number | null,
  price: number | null
): { price: string; mult: string } {
  if (
    dogeMcap == null ||
    supply == null ||
    supply <= 0 ||
    !Number.isFinite(dogeMcap)
  ) {
    return { price: "—", mult: "—" }
  }
  const zp = (dogeMcap * mult) / supply
  const m = price != null && price > 0 ? zp / price : null
  return { price: fmtImpliedPrice(zp), mult: fmtMultiple(m) }
}

// Palette mirrors the live page so the OG embed reads as a "snapshot
// of the page" rather than an unrelated banner.
const BG = "#000000"
const TEXT = "#dcfce7"
const TEXT_DIM = "#86efac"
const CYPH = "#34d399"
const ZEC = "#fde047"
const RATIO = "#67e8f9"
const MUTED = "rgba(220, 252, 231, 0.55)"
const DIVIDER = "rgba(220, 252, 231, 0.18)"
const SCANLINE = "rgba(52, 211, 153, 0.06)"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${url.host}`
  const requireComplete = wantsCompleteOgImage(request)
  const btcBasis = url.searchParams.get("btcBasis") === "price" ? "price" : "mcap"
  const s = await fetchSnapshot(origin)
  if (requireComplete) {
    const missing = missingSnapshotFields(s)
    if (missing.length > 0) {
      return missingOgDataResponse("/api/og/what-if", missing)
    }
  }

  const stamp =
    new Date().toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"

  // Pre-compute the rows once so the JSX below stays readable.
  const btc = [0.01, 0.02, 0.05].map((sh) =>
    btcBasis === "price"
      ? priceRow(s.btcPrice, sh, s.zecPrice)
      : row(s.btcMcap, sh, s.zecSupply, s.zecPrice)
  )
  const gold = [0.0005, 0.001, 0.005].map((sh) =>
    row(s.goldMcap, sh, s.zecSupply, s.zecPrice)
  )
  const offshore = [0.001, 0.005, 0.01].map((sh) =>
    row(s.offshoreMcap, sh, s.zecSupply, s.zecPrice)
  )
  const stables = [0.05, 0.1, 0.25].map((sh) =>
    row(s.stablesMcap, sh, s.zecSupply, s.zecPrice)
  )
  const globalEcon = [0.0005, 0.001, 0.005].map((sh) =>
    row(s.globalEconomyMcap, sh, s.zecSupply, s.zecPrice)
  )
  const doge = [1, 2, 5].map((m) =>
    dogeRow(s.dogeMcap, m, s.zecSupply, s.zecPrice)
  )

  // Format ZEC's current share-of-BTC for the NOW strip — that's the
  // most recognizable benchmark for crypto audiences and gives the OG
  // a live "where ZEC sits today" data point.
  const zecMcap =
    s.zecPrice != null && s.zecSupply != null
      ? s.zecPrice * s.zecSupply
      : null
  const zecShareOfBtc =
    zecMcap != null && s.btcMcap != null && s.btcMcap > 0
      ? (zecMcap / s.btcMcap) * 100
      : null
  const zecPriceLabel =
    s.zecPrice != null ? `ZEC $${s.zecPrice.toFixed(2)}` : "ZEC LIVE"
  const zecShareLabel =
    zecShareOfBtc != null ? `${zecShareOfBtc.toFixed(2)}% of BTC` : null

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: BG,
          color: TEXT,
          padding: "36px 48px",
          fontFamily: "monospace",
          // Subtle horizontal scan-line gradient to evoke the cz-app's
          // CRT overlay without going overboard at OG scale.
          backgroundImage: `repeating-linear-gradient(0deg, ${SCANLINE} 0px, ${SCANLINE} 1px, transparent 1px, transparent 4px)`,
        }}
      >
        {/* HEADER — sans-serif H1 on the left, NOW strip on the right */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: "52px",
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              fontFamily: "sans-serif",
            }}
          >
            What{" "}
            <span
              style={{
                color: ZEC,
                marginLeft: "16px",
                marginRight: "20px",
              }}
            >
              ZEC
            </span>
            could be{" "}
            <span style={{ color: CYPH, marginLeft: "16px" }}>worth.</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "4px",
              fontSize: "18px",
              color: RATIO,
              letterSpacing: "0.15em",
              marginTop: "12px",
            }}
          >
            <span style={{ display: "flex", opacity: 0.9 }}>
              NOW · {zecPriceLabel}
            </span>
            {zecShareLabel && (
              <span
                style={{
                  display: "flex",
                  color: TEXT_DIM,
                  opacity: 0.7,
                }}
              >
                {zecShareLabel}
              </span>
            )}
          </div>
        </div>

        {/* 2 × 3 GRID of market mini-sections */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", gap: "32px", flex: 1 }}>
            <MiniSection
              name={btcBasis === "price" ? "Bitcoin - price" : "Bitcoin - mcap"}
              mcap={
                btcBasis === "price"
                  ? fmtSpot(s.btcPrice)
                  : `${fmtMcap(s.btcMcap)} - ${fmtSpot(s.btcPrice)}`
              }
              labels={["1%", "2%", "5%"]}
              rows={btc}
            />
            <MiniSection
              name="Gold"
              mcap={fmtMcap(s.goldMcap)}
              labels={["0.05%", "0.1%", "0.5%"]}
              rows={gold}
            />
          </div>
          <div style={{ display: "flex", gap: "32px", flex: 1 }}>
            <MiniSection
              name="Offshore wealth"
              mcap={fmtMcap(s.offshoreMcap)}
              labels={["0.1%", "0.5%", "1%"]}
              rows={offshore}
            />
            <MiniSection
              name="Stablecoins"
              mcap={fmtMcap(s.stablesMcap)}
              labels={["5%", "10%", "25%"]}
              rows={stables}
            />
          </div>
          <div style={{ display: "flex", gap: "32px", flex: 1 }}>
            <MiniSection
              name="Global economy"
              mcap={fmtMcap(s.globalEconomyMcap)}
              labels={["0.05%", "0.1%", "0.5%"]}
              rows={globalEcon}
            />
            <MiniSection
              name="Dogecoin"
              mcap={`${fmtMcap(s.dogeMcap)} - ${fmtSpot(s.dogePrice)}`}
              labels={["= DOGE", "2× DOGE", "5× DOGE"]}
              rows={doge}
            />
          </div>
        </div>

        {/* FOOTER */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "20px",
            paddingTop: "12px",
            borderTop: `1px solid ${DIVIDER}`,
            fontSize: "16px",
            color: MUTED,
            letterSpacing: "0.15em",
          }}
        >
          <div style={{ display: "flex" }}>cyphzec.com/what-if</div>
          <div style={{ display: "flex" }}>UPDATED {stamp}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // CF edge caches this for 1 hour, then serves stale-while-revalidate
        // for up to 24h while a fresh render runs in the background. Paired
        // with the page's hour-grain ?h=YYYYMMDDHH cache buster so each
        // hour Twitter / Facebook see a new URL and re-fetch.
        ...ogHeaders(
          requireComplete,
          "public, s-maxage=3600, stale-while-revalidate=86400"
        ),
      },
    }
  )
}

// ── Mini-section component (in-file because it's only used here). ───
function MiniSection({
  name,
  mcap,
  labels,
  rows,
}: {
  name: string
  mcap: string
  labels: string[]
  rows: { price: string; mult: string }[]
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "12px 16px",
        gap: "8px",
      }}
    >
      {/* Section header — sans-serif name + dim mcap on the right */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          paddingBottom: "6px",
          borderBottom: `1px solid ${DIVIDER}`,
        }}
      >
        <span
          style={{
            display: "flex",
            fontSize: "26px",
            fontWeight: 700,
            fontFamily: "sans-serif",
            color: TEXT,
            letterSpacing: "-0.01em",
          }}
        >
          {name}
        </span>
        <span style={{ display: "flex", fontSize: "16px", color: MUTED }}>
          {mcap}
        </span>
      </div>
      {/* Rows — share / implied price / multiplier */}
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            fontSize: "18px",
            color: TEXT,
            letterSpacing: "0.02em",
          }}
        >
          <span
            style={{
              display: "flex",
              flexBasis: "30%",
              color: TEXT_DIM,
              opacity: 0.85,
            }}
          >
            {labels[i]}
          </span>
          <span
            style={{
              display: "flex",
              flexBasis: "40%",
              justifyContent: "flex-end",
            }}
          >
            {r.price}
          </span>
          <span
            style={{
              display: "flex",
              flexBasis: "25%",
              justifyContent: "flex-end",
              color: RATIO,
              fontWeight: 700,
            }}
          >
            {r.mult}
          </span>
        </div>
      ))}
    </div>
  )
}
