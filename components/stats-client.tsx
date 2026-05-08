"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import {
  ArrowLeft,
  ListOrdered,
  ShieldCheck,
  Coins,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
} from "lucide-react"
import { PerfChip } from "@/components/perf-chip"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface MarketCoin {
  rank: number
  symbol: string
  name: string
  id: string
  marketCap: number | null
  price: number | null
  change24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  image: string | null
}

interface MarketsResponse {
  coins: MarketCoin[]
  fetchedAt: number
  source: string
}

interface ShieldedBreakdown {
  total: number
  sprout: number
  sapling: number
  orchard: number
  lockbox: number
  transparent: number
  pct: number
  source: string
}

interface ZecStats {
  rank: number | null
  marketCap: number | null
  price: number | null
  change24h: number | null
  mcapChange24h: number | null
  mcapChange7d: number | null
  mcapChange30d: number | null
  circulating: number | null
  total: number | null
  max: number
  ath: number | null
  athChangePct: number | null
  shielded: number | null
  shieldedPct: number | null
  shieldedBreakdown: ShieldedBreakdown | null
  shieldedSource: string | null
  source: string | null
  fetchedAt: number
}

const ZEC_COLOR = "#fb923c"
const GOOD = "#34d399"
const BAD = "#f87171"

// ─── formatting helpers ─────────────────────────────────────────────────────

function fmtMcap(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtPrice(p: number | null) {
  if (p == null) return "—"
  if (p >= 1)
    return `$${p.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  return `$${p.toFixed(4)}`
}

function fmtPct(p: number | null) {
  if (p == null) return "—"
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`
}

function fmtSignedUSD(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : ""
  return `${sign}${fmtMcap(Math.abs(n))}`
}

function fmtCount(n: number | null) {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

// ─── shared ──────────────────────────────────────────────────────────────────

export function StatsClient() {
  const [tab, setTab] = useState<"rankings" | "supply">("rankings")
  return (
    <div className="flex flex-col gap-4">
      {/* Tab bar */}
      <div className="rounded-lg border border-border bg-card flex flex-wrap">
        {(
          [
            { id: "rankings", label: "Rankings", icon: ListOrdered },
            { id: "supply", label: "ZEC Supply", icon: Coins },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === "rankings" && <RankingsTab />}
      {tab === "supply" && <SupplyTab />}

      <Link
        href="/"
        className="self-start flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors pt-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>
    </div>
  )
}

// ─── Rankings tab ────────────────────────────────────────────────────────────

function RankingsTab() {
  const { data, error, isLoading } = useSWR<MarketsResponse>(
    "/api/markets",
    fetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const [showPct, setShowPct] = useState(false)

  const zec = useMemo(
    () => data?.coins.find((c) => c.symbol === "ZEC") ?? null,
    [data?.coins]
  )

  // We render top 20 by default. If ZEC isn't in top 20, we still show
  // a focused window of ZEC ± 3 below the table.
  const coins = data?.coins ?? []
  const top20 = coins.slice(0, 20)
  const zecInTop20 = (zec?.rank ?? 999) <= 20
  const neighbors = useMemo(() => {
    if (!zec || zecInTop20) return []
    const idx = coins.findIndex((c) => c.symbol === "ZEC")
    if (idx < 0) return []
    return coins.slice(Math.max(0, idx - 3), Math.min(coins.length, idx + 4))
  }, [coins, zec, zecInTop20])

  if (isLoading && !data) {
    return (
      <p className="text-sm text-muted-foreground p-4">
        Loading top 50 by market cap…
      </p>
    )
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground p-4">
        Couldn&rsquo;t load market data right now. Try again in a bit.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-mono text-muted-foreground">
          {zec ? (
            <>
              <span style={{ color: ZEC_COLOR }}>$ZEC</span> rank{" "}
              <span className="text-foreground font-bold">#{zec.rank}</span> ·
              market cap {fmtMcap(zec.marketCap)} · ZEC needs to move to
              overtake / be overtaken below
            </>
          ) : (
            "ZEC not found in top 50"
          )}
        </p>
        {/* $ vs % toggle for the gap column */}
        <div className="flex items-center text-[10px] font-mono">
          <button
            onClick={() => setShowPct(false)}
            className={`px-2 py-1 rounded-l border ${
              !showPct
                ? "bg-secondary text-foreground border-border"
                : "border-border/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            $
          </button>
          <button
            onClick={() => setShowPct(true)}
            className={`px-2 py-1 rounded-r border-y border-r ${
              showPct
                ? "bg-secondary text-foreground border-border"
                : "border-border/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            %
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <RankingsTable coins={top20} zec={zec} showPct={showPct} />
      </div>

      {neighbors.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground pt-2">
            Near $ZEC (rank #{zec?.rank})
          </h3>
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <RankingsTable coins={neighbors} zec={zec} showPct={showPct} />
          </div>
        </div>
      )}

      <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed pt-1">
        Market data via{" "}
        {data.source === "coingecko" ? "CoinGecko" : "CoinPaprika"}, cached at
        the edge for ~10 minutes. The &ldquo;Δ to ZEC&rdquo; column shows what
        $ZEC&apos;s spot price would need to change by, holding circulating
        supply constant, for ZEC&apos;s market cap to cross the listed
        coin&apos;s. Naive math: ignores supply emissions and price impact on
        either side.
      </p>
    </div>
  )
}

function RankingsTable({
  coins,
  zec,
  showPct,
}: {
  coins: MarketCoin[]
  zec: MarketCoin | null
  showPct: boolean
}) {
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border/40">
          <th className="text-left px-3 py-2 font-normal w-10">#</th>
          <th className="text-left px-2 py-2 font-normal">Coin</th>
          <th className="text-right px-2 py-2 font-normal">Market cap</th>
          <th className="text-right px-2 py-2 font-normal hidden sm:table-cell">
            Price
          </th>
          <th className="text-right px-2 py-2 font-normal hidden md:table-cell">
            24h
          </th>
          <th className="text-right px-3 py-2 font-normal">Δ to ZEC</th>
        </tr>
      </thead>
      <tbody>
        {coins.map((c) => (
          <RankingsRow key={c.id} c={c} zec={zec} showPct={showPct} />
        ))}
      </tbody>
    </table>
  )
}

function RankingsRow({
  c,
  zec,
  showPct,
}: {
  c: MarketCoin
  zec: MarketCoin | null
  showPct: boolean
}) {
  const isZec = c.symbol === "ZEC"
  // Δ math: how much would ZEC's spot price need to change so ZEC's
  // market cap crosses this coin's? Holds ZEC supply constant.
  let deltaZecPrice: number | null = null
  let deltaPct: number | null = null
  if (
    !isZec &&
    zec &&
    zec.marketCap != null &&
    zec.circulatingSupply != null &&
    zec.circulatingSupply > 0 &&
    c.marketCap != null &&
    zec.price != null &&
    zec.price > 0
  ) {
    const deltaMcap = c.marketCap - zec.marketCap
    deltaZecPrice = deltaMcap / zec.circulatingSupply
    deltaPct = (deltaZecPrice / zec.price) * 100
  }
  // Direction: positive delta = competitor is ABOVE ZEC, ZEC needs to
  // gain to overtake. Negative = ZEC is ahead, the competitor would
  // need ZEC to give up that much before being overtaken.
  const ahead = deltaZecPrice != null && deltaZecPrice < 0
  const behind = deltaZecPrice != null && deltaZecPrice > 0
  const change24hUp = (c.change24h ?? 0) >= 0

  return (
    <tr
      className={`border-b border-border/20 last:border-b-0 transition-colors ${
        isZec ? "" : "hover:bg-muted/20"
      }`}
      style={
        isZec
          ? { backgroundColor: `${ZEC_COLOR}10`, borderColor: `${ZEC_COLOR}30` }
          : undefined
      }
    >
      <td className="px-3 py-2 text-muted-foreground">
        {isZec && <span style={{ color: ZEC_COLOR }}>★</span>}#{c.rank}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {c.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.image}
              alt=""
              width={16}
              height={16}
              className="rounded-full flex-shrink-0"
              loading="lazy"
            />
          )}
          <span
            className="font-bold whitespace-nowrap"
            style={isZec ? { color: ZEC_COLOR } : { color: "var(--foreground)" }}
          >
            {c.symbol}
          </span>
          <span className="text-muted-foreground truncate hidden sm:inline">
            {c.name}
          </span>
        </div>
      </td>
      <td className="px-2 py-2 text-right text-foreground whitespace-nowrap">
        {fmtMcap(c.marketCap)}
      </td>
      <td className="px-2 py-2 text-right text-muted-foreground whitespace-nowrap hidden sm:table-cell">
        {fmtPrice(c.price)}
      </td>
      <td
        className={`px-2 py-2 text-right whitespace-nowrap hidden md:table-cell ${
          c.change24h == null
            ? "text-muted-foreground"
            : change24hUp
              ? "text-green-400"
              : "text-red-400"
        }`}
      >
        {fmtPct(c.change24h)}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {isZec ? (
          <span className="text-muted-foreground">— here —</span>
        ) : deltaZecPrice == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className="inline-flex items-center gap-0.5"
            style={{ color: ahead ? GOOD : BAD }}
            title={
              ahead
                ? `ZEC has a ${fmtMcap(Math.abs(deltaZecPrice * (zec?.circulatingSupply ?? 0)))} market-cap cushion over ${c.symbol}`
                : `ZEC needs to gain ${fmtMcap(Math.abs(deltaZecPrice * (zec?.circulatingSupply ?? 0)))} of market cap to overtake ${c.symbol}`
            }
          >
            {ahead ? (
              <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            )}
            {showPct
              ? `${behind ? "+" : ""}${(deltaPct ?? 0).toFixed(1)}%`
              : `${behind ? "+" : "−"}$${Math.abs(deltaZecPrice).toFixed(deltaZecPrice > 100 ? 0 : 2)}`}
          </span>
        )}
      </td>
    </tr>
  )
}

// ─── Supply tab ──────────────────────────────────────────────────────────────

function SupplyTab() {
  const { data, error, isLoading } = useSWR<ZecStats>("/api/zec-stats", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })

  if (isLoading && !data) {
    return <p className="text-sm text-muted-foreground p-4">Loading…</p>
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground p-4">
        Couldn&rsquo;t load ZEC supply data right now.
      </p>
    )
  }

  // Prefer the cipherscan-provided breakdown when available — it's
  // computed from the chain itself and includes the pool split. Fall
  // back to the legacy single-number shielded total + a derived
  // transparent split for older payloads.
  const breakdown = data.shieldedBreakdown
  const transparent =
    breakdown?.transparent ??
    (data.shielded != null && data.circulating != null
      ? Math.max(data.circulating - data.shielded, 0)
      : null)
  const shieldedPct =
    data.shieldedPct ??
    (data.shielded != null && data.circulating != null && data.circulating > 0
      ? (data.shielded / data.circulating) * 100
      : null)
  const minedPct =
    data.circulating != null && data.max > 0
      ? (data.circulating / data.max) * 100
      : null

  return (
    <div className="flex flex-col gap-3">
      {/* Top stat grid: rank · price · mcap · 24h */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SupplyStat label="Rank" value={data.rank ? `#${data.rank}` : "—"} accent={ZEC_COLOR} />
        <SupplyStat label="Price" value={fmtPrice(data.price)} sub={fmtPct(data.change24h) + " 24h"} />
        <SupplyStat label="Market cap" value={fmtMcap(data.marketCap)} />
        <SupplyStat
          label="ATH"
          value={fmtPrice(data.ath)}
          sub={data.athChangePct != null ? `${fmtPct(data.athChangePct)} from ATH` : ""}
        />
      </section>

      {/* Mcap performance chips — all three windows computed off the
          daily mcap series so each chip is a true mcap delta (price ×
          supply), not a price tick relabeled. Mirrors the chips shown
          on the dashboard ZEC tile so the two stay in lockstep. */}
      <section className="flex flex-wrap items-center gap-2 -mt-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Mcap perf
        </span>
        <PerfChip label="24h" pct={data.mcapChange24h} />
        <PerfChip label="7D" pct={data.mcapChange7d} />
        <PerfChip label="30D" pct={data.mcapChange30d} />
      </section>

      {/* Circulating supply card */}
      <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Circulating supply
          </h2>
          {minedPct != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {minedPct.toFixed(1)}% of 21M cap
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl md:text-3xl font-mono font-bold text-foreground leading-none">
              {data.circulating != null
                ? fmtCount(Math.round(data.circulating))
                : "—"}
            </span>
            <span className="text-xs font-mono text-muted-foreground">ZEC</span>
            <span className="ml-auto text-xs font-mono text-muted-foreground">
              {data.max != null ? fmtCount(data.max) : "21,000,000"} max
            </span>
          </div>
          {/* Linear bar: circulating ÷ max */}
          {minedPct != null && (
            <div className="relative h-2 rounded-full bg-secondary overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${Math.min(minedPct, 100)}%`,
                  backgroundColor: ZEC_COLOR,
                }}
              />
            </div>
          )}
          <p className="text-[10px] font-mono text-muted-foreground/70">
            {data.circulating != null
              ? `${fmtCount(Math.round(21_000_000 - data.circulating))} ZEC still to be mined.`
              : "Supply data unavailable."}
          </p>
        </div>
      </section>

      {/* Shielded supply card */}
      <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Shielded supply
          </h2>
          {data.shielded == null && (
            <span className="text-[10px] font-mono text-muted-foreground/70">
              data not available right now
            </span>
          )}
        </div>
        {data.shielded != null && data.circulating != null ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl md:text-3xl font-mono font-bold text-foreground leading-none">
                {fmtCount(Math.round(data.shielded))}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                ZEC shielded
              </span>
              {shieldedPct != null && (
                <span className="ml-auto text-xs font-mono text-muted-foreground">
                  {shieldedPct.toFixed(2)}% of circulating
                </span>
              )}
            </div>
            {/* Stacked bar: shielded pools (orchard / sapling / sprout /
                lockbox) vs transparent. When a per-pool breakdown is
                available we render each pool as its own segment so the
                user can eyeball the orchard-vs-sapling shift; otherwise
                we fall back to a 2-tone bar. */}
            {shieldedPct != null &&
              (breakdown ? (
                <PoolBar breakdown={breakdown} circulating={data.circulating} />
              ) : (
                <div className="relative h-2 rounded-full bg-secondary overflow-hidden flex">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(shieldedPct, 100)}%`,
                      backgroundColor: GOOD,
                    }}
                  />
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.max(100 - shieldedPct, 0)}%`,
                      backgroundColor: "#475569",
                    }}
                  />
                </div>
              ))}

            {/* Per-pool legend: only shown when cipherscan returned the
                breakdown. Sapling + Orchard are the two live shielded
                pools; Sprout is the legacy original shielded pool
                (effectively retired); Lockbox is the NU6 funding
                stream sink. */}
            {breakdown ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <PoolLegend
                  name="Orchard"
                  count={breakdown.orchard}
                  pct={
                    data.circulating > 0
                      ? (breakdown.orchard / data.circulating) * 100
                      : 0
                  }
                  color="#34d399"
                />
                <PoolLegend
                  name="Sapling"
                  count={breakdown.sapling}
                  pct={
                    data.circulating > 0
                      ? (breakdown.sapling / data.circulating) * 100
                      : 0
                  }
                  color="#6ee7b7"
                />
                <PoolLegend
                  name="Sprout"
                  count={breakdown.sprout}
                  pct={
                    data.circulating > 0
                      ? (breakdown.sprout / data.circulating) * 100
                      : 0
                  }
                  color="#a7f3d0"
                />
                <PoolLegend
                  name="Lockbox"
                  count={breakdown.lockbox}
                  pct={
                    data.circulating > 0
                      ? (breakdown.lockbox / data.circulating) * 100
                      : 0
                  }
                  color="#fbbf24"
                />
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] font-mono text-muted-foreground">
                <span>
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full mr-1 align-middle"
                    style={{ backgroundColor: GOOD }}
                  />
                  shielded {fmtCount(Math.round(data.shielded))}
                </span>
                <span>
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full mr-1 align-middle"
                    style={{ backgroundColor: "#475569" }}
                  />
                  transparent{" "}
                  {transparent != null ? fmtCount(Math.round(transparent)) : "—"}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground/80 pt-1">
              <span>
                Transparent:{" "}
                {transparent != null ? fmtCount(Math.round(transparent)) : "—"} ZEC
              </span>
              {data.shieldedSource && (
                <a
                  href="https://cipherscan.app/network"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                >
                  via cipherscan <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground/80 leading-relaxed">
            Live shielded-pool data is temporarily unavailable. For the
            latest, see{" "}
            <a
              href="https://cipherscan.app/network"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
            >
              cipherscan
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            or{" "}
            <a
              href="https://electriccoin.co/zcash-network-charts/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
            >
              ECC charts
              <ExternalLink className="h-3 w-3" />
            </a>
            .
          </div>
        )}
      </section>

      <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed pt-1">
        Market data via{" "}
        {data.source === "coingecko" ? "CoinGecko" : "CoinPaprika"}, shielded
        pool breakdown via{" "}
        <a
          href="https://cipherscan.app/network"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors underline-offset-2 hover:underline"
        >
          cipherscan
        </a>{" "}
        (live from a Zebra full node). All upstreams cached in Cloudflare KV
        for 1h.
      </p>
    </div>
  )
}

function PoolBar({
  breakdown,
  circulating,
}: {
  breakdown: ShieldedBreakdown
  circulating: number
}) {
  if (circulating <= 0) return null
  const pct = (n: number) => Math.max(0, (n / circulating) * 100)
  const orchardPct = pct(breakdown.orchard)
  const saplingPct = pct(breakdown.sapling)
  const sproutPct = pct(breakdown.sprout)
  const lockboxPct = pct(breakdown.lockbox)
  const transparentPct = Math.max(
    0,
    100 - orchardPct - saplingPct - sproutPct - lockboxPct
  )
  return (
    <div
      className="relative h-2 rounded-full bg-secondary overflow-hidden flex"
      role="img"
      aria-label={`Shielded pool breakdown: orchard ${orchardPct.toFixed(1)}%, sapling ${saplingPct.toFixed(1)}%, sprout ${sproutPct.toFixed(2)}%, lockbox ${lockboxPct.toFixed(2)}%, transparent ${transparentPct.toFixed(1)}%`}
    >
      <div
        className="h-full"
        style={{ width: `${orchardPct}%`, backgroundColor: "#34d399" }}
        title={`Orchard ${orchardPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${saplingPct}%`, backgroundColor: "#6ee7b7" }}
        title={`Sapling ${saplingPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${sproutPct}%`, backgroundColor: "#a7f3d0" }}
        title={`Sprout ${sproutPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${lockboxPct}%`, backgroundColor: "#fbbf24" }}
        title={`Lockbox ${lockboxPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${transparentPct}%`, backgroundColor: "#475569" }}
        title={`Transparent ${transparentPct.toFixed(2)}%`}
      />
    </div>
  )
}

function PoolLegend({
  name,
  count,
  pct,
  color,
}: {
  name: string
  count: number
  pct: number
  color: string
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span
        className="h-2 w-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <span className="text-xs font-mono text-foreground truncate">
          {fmtCount(Math.round(count))}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/70">
          {pct.toFixed(pct < 1 ? 2 : 1)}%
        </span>
      </div>
    </div>
  )
}

function SupplyStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div
      className="rounded-lg border bg-card p-3 flex flex-col gap-0.5"
      style={{ borderColor: accent ? `${accent}33` : undefined }}
    >
      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className="text-base md:text-lg font-mono font-bold text-foreground leading-tight"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] font-mono text-muted-foreground">
          {sub}
        </span>
      )}
    </div>
  )
}
