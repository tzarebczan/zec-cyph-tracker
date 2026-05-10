"use client"

import useSWR from "swr"
import Link from "next/link"
import { ArrowLeft, ExternalLink } from "lucide-react"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface HoldingsResponse {
  transactions: {
    id: string
    date: string
    type: "buy" | "sell"
    assetSymbol: string
    assetName: string
    amount: number | null
    unitPrice: number | null
    totalValue: number | null
  }[]
  summary: {
    totalZec: number
    totalCostUSD: number
    avgCostPerZec: number | null
    transactionCount: number
    buyCount: number
    sellCount: number
    firstTransactionAt: string | null
    lastTransactionAt: string | null
  }
  supply?: {
    circulating: number | null
    max: number
    pctOfCirculating: number | null
    pctOfMax: number | null
    targetPct: number
    progressTowardTarget: number | null
  }
  fetchedAt: number
}

interface PriceData {
  current?: { zec?: { price: number | null } }
}

interface QuoteSnapshot {
  marketState: string
  regularMarketPrice: number | null
  preMarketPrice: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketTime: number | null
  overnightMarketPrice: number | null
  overnightMarketTime: number | null
  sharesOutstanding: number | null
}

const ZEC_COLOR = "#fb923c"

function fmtCount(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function fmtUSD(n: number | null, opts: Intl.NumberFormatOptions = {}) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    ...opts,
  })
}

function fmtUSDPrecise(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtCompactUSD(n: number) {
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    })}M`
  if (Math.abs(n) >= 1000)
    return `$${(n / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })}k`
  return fmtUSD(n)
}

function fmtDate(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function HoldingsClient() {
  const { data, error, isLoading } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    fetcher,
    {
      refreshInterval: 60 * 60_000,
      keepPreviousData: true,
    }
  )
  const { data: priceData } = useSWR<PriceData>("/api/prices?days=7", fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  const { data: quoteData } = useSWR<QuoteSnapshot>("/api/quote", fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })

  if (isLoading && !data) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading transactions from cypherpunk.com…
      </p>
    )
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground">
        Couldn&rsquo;t load transactions from cypherpunk.com right now. Try
        again in a bit.
      </p>
    )
  }

  const s = data.summary
  const liveZec = priceData?.current?.zec?.price ?? null
  const currentValue = liveZec != null ? s.totalZec * liveZec : null
  const unrealizedUSD =
    currentValue != null ? currentValue - s.totalCostUSD : null
  const unrealizedPct =
    currentValue != null && s.totalCostUSD > 0
      ? ((currentValue - s.totalCostUSD) / s.totalCostUSD) * 100
      : null

  // NAV per share = (treasury value at live ZEC price) / shares outstanding.
  // This is a simplified ZEC-only NAV — Cypherpunk Technologies' balance
  // sheet has cash + other items beyond ZEC, but ZEC is the dominant
  // treasury position so the approximation is meaningful for tracking
  // premium / discount to ZEC backing. mNAV = stock price / NAV per share.
  const sharesOutstanding = quoteData?.sharesOutstanding ?? null
  const cyphPrice = quoteData?.regularMarketPrice ?? null
  const navPerShare =
    currentValue != null && sharesOutstanding != null && sharesOutstanding > 0
      ? currentValue / sharesOutstanding
      : null
  const mNav =
    cyphPrice != null && navPerShare != null && navPerShare > 0
      ? cyphPrice / navPerShare
      : null
  const divergencePct =
    cyphPrice != null && navPerShare != null && navPerShare > 0
      ? ((cyphPrice - navPerShare) / navPerShare) * 100
      : null
  const divergenceUSD =
    cyphPrice != null && navPerShare != null
      ? cyphPrice - navPerShare
      : null

  // Build cumulative-holdings rows for the table (smallest = oldest first)
  const txsOldestFirst = [...data.transactions]
    .filter((t) => t.assetSymbol === "ZEC")
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  let runningZec = 0
  const txTable = txsOldestFirst.map((t) => {
    const sign = t.type === "buy" ? 1 : -1
    runningZec += (t.amount ?? 0) * sign
    return { ...t, runningZec }
  })
  // Show newest first in the UI
  const txTableNewestFirst = [...txTable].reverse()

  return (
    <div className="flex flex-col gap-4">
      {/* Big stats grid */}
      <section
        aria-labelledby="totals-heading"
        className="grid grid-cols-2 md:grid-cols-4 gap-2"
      >
        <h2 id="totals-heading" className="sr-only">
          Treasury totals
        </h2>
        <Stat
          label="Total ZEC held"
          value={fmtCount(s.totalZec)}
          sublabel={`${s.buyCount} buys${s.sellCount > 0 ? ` · ${s.sellCount} sells` : ""}`}
          accent={ZEC_COLOR}
        />
        <Stat
          label="Cost basis"
          value={fmtCompactUSD(s.totalCostUSD)}
          sublabel="USD invested"
        />
        <Stat
          label="Avg cost / ZEC"
          value={
            s.avgCostPerZec != null ? fmtUSDPrecise(s.avgCostPerZec) : "—"
          }
          sublabel="weighted avg"
        />
        <Stat
          label="Current value"
          value={currentValue != null ? fmtCompactUSD(currentValue) : "—"}
          sublabel={
            liveZec != null
              ? `${s.totalZec.toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })} × ${fmtUSDPrecise(liveZec)}`
              : ""
          }
        />
      </section>

      {/* Supply Acquisition Progress — semicircular gauge that visualizes
          how much of CYPH's stated 5%-of-supply target has been reached.
          Self-hides if CoinGecko supply data is missing. */}
      {data.supply?.pctOfCirculating != null && (
        <SupplyProgressCard
          supply={data.supply}
          totalZec={s.totalZec}
          liveZec={liveZec}
        />
      )}

      {/* Unrealized P&L card */}
      {unrealizedUSD != null && unrealizedPct != null && (
        <section
          aria-labelledby="pnl-heading"
          className="rounded-lg border bg-card p-3 md:p-4 flex flex-col gap-1"
          style={{
            borderColor: unrealizedUSD >= 0 ? "#34d39955" : "#f8717155",
          }}
        >
          <h2
            id="pnl-heading"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
          >
            Unrealized at current $ZEC price
          </h2>
          <div className="flex items-baseline flex-wrap gap-3">
            <span
              className={`text-2xl md:text-3xl font-mono font-bold leading-none ${
                unrealizedUSD >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {unrealizedUSD >= 0 ? "+" : "−"}
              {fmtCompactUSD(Math.abs(unrealizedUSD))}
            </span>
            <span
              className={`text-base font-mono ${
                unrealizedPct >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              ({unrealizedPct >= 0 ? "+" : ""}
              {unrealizedPct.toFixed(1)}%)
            </span>
          </div>
        </section>
      )}

      {/* Net Asset Value (NAV per share) — treasury value divided by shares
          outstanding, compared against the live $CYPH price to show
          premium / discount. Only renders when we have shares outstanding
          (Yahoo updates this from the most recent 10-Q/10-K, can lag a
          few weeks behind a recent issuance). */}
      {navPerShare != null && cyphPrice != null && (
        <section
          aria-labelledby="nav-heading"
          className="rounded-lg border bg-card p-3 md:p-4 flex flex-col gap-3"
          style={{
            borderColor:
              divergencePct != null && divergencePct >= 0
                ? "#34d39955"
                : "#f8717155",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <h2
              id="nav-heading"
              className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
            >
              Net Asset Value
            </h2>
            {sharesOutstanding != null && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {(sharesOutstanding / 1_000_000).toFixed(1)}M shares
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs font-mono">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                NAV / share
              </span>
              <span className="text-base md:text-lg font-bold text-foreground">
                {fmtUSDPrecise(navPerShare)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                $CYPH price
              </span>
              <span className="text-base md:text-lg font-bold text-foreground">
                {fmtUSDPrecise(cyphPrice)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {divergencePct != null && divergencePct >= 0
                  ? "Premium"
                  : "Discount"}
              </span>
              <span
                className={`text-base md:text-lg font-bold ${
                  divergencePct != null && divergencePct >= 0
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {divergencePct != null && (
                  <>
                    {divergencePct >= 0 ? "+" : ""}
                    {divergencePct.toFixed(1)}%
                  </>
                )}
              </span>
              {divergenceUSD != null && (
                <span className="text-[10px] text-muted-foreground">
                  {divergenceUSD >= 0 ? "+" : "−"}
                  {fmtUSDPrecise(Math.abs(divergenceUSD))} / share
                  {mNav != null && ` · ${mNav.toFixed(2)}× mNAV`}
                </span>
              )}
            </div>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed">
            Simplified ZEC-only NAV: treasury ZEC × live $ZEC ÷ shares
            outstanding. Cash and other balance-sheet items are not included,
            so this is a directional metric, not the SEC-reported NAV.
          </p>
        </section>
      )}

      {/* Transactions table */}
      <section
        aria-labelledby="tx-heading"
        className="rounded-lg border border-border bg-card flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 p-3 md:px-4 border-b border-border/60">
          <h2
            id="tx-heading"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
          >
            Transactions ({data.transactions.length})
          </h2>
          <a
            href="https://cypherpunk.com/investors/sec-filings"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            SEC filings
            <ExternalLink className="size-3" />
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border/40">
                <th className="text-left px-3 md:px-4 py-2 font-normal">Date</th>
                <th className="text-left p-2 font-normal">Type</th>
                <th className="text-right p-2 font-normal">Amount</th>
                <th className="text-right p-2 font-normal hidden sm:table-cell">
                  Unit
                </th>
                <th className="text-right p-2 font-normal">Total</th>
                <th className="text-right px-3 md:px-4 py-2 font-normal hidden md:table-cell">
                  Cumulative
                </th>
              </tr>
            </thead>
            <tbody>
              {txTableNewestFirst.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border/20 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-3 md:px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {fmtDate(t.date)}
                  </td>
                  <td className="p-2">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold uppercase ${
                        t.type === "buy"
                          ? "bg-green-500/15 text-green-400 border-green-500/30"
                          : "bg-red-500/15 text-red-400 border-red-500/30"
                      }`}
                    >
                      {t.type}
                    </span>
                  </td>
                  <td className="p-2 text-right text-foreground">
                    {t.amount != null
                      ? `${fmtCount(t.amount)} ${t.assetSymbol}`
                      : "—"}
                  </td>
                  <td className="p-2 text-right text-muted-foreground hidden sm:table-cell">
                    {t.unitPrice != null ? fmtUSDPrecise(t.unitPrice) : "—"}
                  </td>
                  <td className="p-2 text-right text-foreground">
                    {t.totalValue != null
                      ? fmtCompactUSD(t.totalValue)
                      : "—"}
                  </td>
                  <td className="px-3 md:px-4 py-2 text-right text-muted-foreground hidden md:table-cell">
                    {fmtCount(t.runningZec)} ZEC
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed text-center max-w-prose mx-auto pt-1">
        Transaction data sourced live from{" "}
        <a
          href="https://cypherpunk.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground underline-offset-2 hover:underline"
        >
          cypherpunk.com
        </a>
        . Cached at the edge for ~6 hours.
      </p>

      <Link
        href="/"
        className="self-start flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors pt-1"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
    </div>
  )
}

/**
 * Semicircular gauge showing CYPH's progress toward its stated 5% of
 * supply target. Drawn as plain SVG arcs so we don't pull in another
 * charting library. Two arcs:
 *   - background ring (full 180°)
 *   - filled foreground arc (0–180° proportional to progressTowardTarget)
 *
 * Layout: gauge on the left, primary stat block on the right. On
 * narrow viewports the right block stacks below.
 */
function SupplyProgressCard({
  supply,
  totalZec,
  liveZec,
}: {
  supply: NonNullable<HoldingsResponse["supply"]>
  totalZec: number
  liveZec: number | null
}) {
  const ZEC_COLOR = "#fb923c"
  const pct = supply.pctOfCirculating ?? 0
  const target = supply.targetPct
  const progress = supply.progressTowardTarget ?? 0
  const pctRemaining = Math.max(target - pct, 0)
  const zecRemaining =
    supply.circulating != null
      ? Math.max(supply.circulating * (target / 100) - totalZec, 0)
      : null
  // What it would cost CYPH to buy the rest of the way to the target at
  // the current ZEC spot price. Doesn't model price impact / slippage —
  // just (ZEC remaining) × (live spot) — same caveat as the NAV card.
  const costToTargetUSD =
    zecRemaining != null && liveZec != null && liveZec > 0
      ? zecRemaining * liveZec
      : null

  // SVG semicircle parameters
  const size = 160
  const strokeWidth = 14
  const radius = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2
  const arcLen = Math.PI * radius // length of the half-circle
  const filled = arcLen * progress

  return (
    <section
      aria-labelledby="supply-progress-heading"
      className="rounded-lg border bg-card p-3 md:p-4 flex flex-col gap-3"
      style={{ borderColor: `${ZEC_COLOR}33` }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="supply-progress-heading"
          className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
        >
          Supply Acquisition Progress
        </h2>
        <span className="text-[10px] font-mono text-muted-foreground">
          {supply.circulating != null
            ? `${(supply.circulating / 1_000_000).toFixed(2)}M ZEC circulating`
            : "—"}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-4">
        {/* Semicircular gauge */}
        <div className="flex-shrink-0 relative" style={{ width: size, height: size / 2 + 12 }}>
          <svg
            viewBox={`0 0 ${size} ${size / 2 + 8}`}
            width={size}
            height={size / 2 + 8}
            aria-hidden="true"
          >
            {/* Background half-circle */}
            <path
              d={`M ${strokeWidth / 2} ${cy}
                  A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${cy}`}
              fill="none"
              stroke="#1f2937"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
            {/* Filled progress arc */}
            <path
              d={`M ${strokeWidth / 2} ${cy}
                  A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${cy}`}
              fill="none"
              stroke={ZEC_COLOR}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${arcLen}`}
            />
            {/* Target tick at 100% (which is the 5% target line) */}
            <circle
              cx={size - strokeWidth / 2}
              cy={cy}
              r={3}
              fill="#fafafa"
            />
          </svg>
          {/* Center label inside the half-circle */}
          <div className="absolute inset-x-0 bottom-1 flex flex-col items-center pointer-events-none">
            <span className="text-2xl font-mono font-bold text-foreground leading-none">
              {pct.toFixed(2)}%
            </span>
            <span className="text-[10px] font-mono text-muted-foreground mt-0.5">
              of {(progress * 100).toFixed(0)}% to {target}%
            </span>
          </div>
        </div>

        {/* Stats block */}
        <div className="flex-1 grid grid-cols-2 gap-2 text-xs font-mono w-full">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Held
            </span>
            <span className="text-base font-bold text-foreground">
              {totalZec.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              <span className="ml-1" style={{ color: ZEC_COLOR }}>ZEC</span>
            </span>
            <span className="text-[10px] text-muted-foreground">
              {pct.toFixed(2)}% of circulating
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Target
            </span>
            <span className="text-base font-bold text-foreground">
              {target}%
              <span className="ml-1 text-muted-foreground">of supply</span>
            </span>
            <span className="text-[10px] text-muted-foreground">
              {zecRemaining != null
                ? `~${(zecRemaining / 1000).toLocaleString("en-US", {
                    maximumFractionDigits: 0,
                  })}K ZEC remaining`
                : `${pctRemaining.toFixed(2)} pp remaining`}
              {/* USD cost to acquire the remaining ZEC at the live spot
                  price — useful for sizing how much capital CYPH still
                  needs to deploy to reach 5%. Naive multiplication, no
                  slippage modelling. */}
              {costToTargetUSD != null && (
                <>
                  {" "}·{" "}
                  <span className="text-foreground/80">
                    ~{fmtCompactUSD(costToTargetUSD)} @{" "}
                    {liveZec != null ? fmtUSDPrecise(liveZec) : "spot"}
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 col-span-2">
            {/* Linear bar for the in-between read; same data, different
                visual angle. Some users grok bars faster than gauges. */}
            <div className="relative h-2 rounded-full bg-secondary overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${Math.min(progress * 100, 100)}%`,
                  backgroundColor: ZEC_COLOR,
                }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground">
              {(progress * 100).toFixed(1)}% of the way to the {target}%
              acquisition target.
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  sublabel,
  accent,
}: {
  label: string
  value: string
  sublabel?: string
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
      {sublabel && (
        <span className="text-[10px] font-mono text-muted-foreground">
          {sublabel}
        </span>
      )}
    </div>
  )
}
