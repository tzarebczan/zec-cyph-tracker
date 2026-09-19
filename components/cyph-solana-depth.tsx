"use client"

import { CornerBox, InfoTip, Skeleton } from "./primitives"
import { paletteVar, withAlpha } from "./theme"
import { fmtCompactNumber, fmtCompactUSD } from "./format"
import { DepthCurve, Ladder, Stat, type BookLike } from "./cyph-depth"
import {
  useCyphSolanaDepth,
  useTokenMarketIsLive,
} from "./use-cyph-solana-depth"
import type { CyphSolanaBook } from "./api-types"

// Depth for the tokenized CYPH share on Solana — the market that is open when
// Nasdaq and Blue Ocean are not.
//
// The pools never close, but this only surfaces while every US venue is shut,
// matching where the 24x7 price takes over the headline. During a session the
// Nasdaq book is the market that matters and two books side by side would
// invite reading a pool's price against an exchange's.
//
// What the ladder is, and what the UI says out loud: an AMM has no resting
// orders. Each rung is the size fillable between the previous rung's average
// price and this one's, measured by quoting real routed trades. The
// cumulative depth that produces is genuine — it is what you could trade
// against right now — but nobody has committed to it, and the liquidity
// behind it can be withdrawn.

function fmtPx(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(2)}`
}

/** `$10k`, or `$10k+` when the ladder never reached the band's edge and the
 *  figure is a floor rather than a measurement. */
function fmtDepth(usd: number | null, atCeiling: boolean): string {
  if (usd == null) return "—"
  return fmtCompactUSD(usd) + (atCeiling ? "+" : "")
}

const WHAT_IT_IS =
  "Automated market maker liquidity, not resting orders. Each level is the " +
  "size fillable between the level above it and its own average price, " +
  "measured by quoting real routed trades through Jupiter. Nobody has " +
  "committed to these prices and the pool behind them can be withdrawn."

export function SolanaBookBadge({ book }: { book: CyphSolanaBook }) {
  const venue = book.routedVia[0] ?? "Solana"
  return (
    <span
      className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.14em] leading-none"
      style={{
        borderColor: paletteVar("cyph"),
        color: paletteVar("cyph"),
        background: withAlpha(paletteVar("cyph"), 14),
      }}
    >
      {`24X7 · ${venue.toUpperCase()}`}
    </span>
  )
}

function SolanaBookBody({ book }: { book: CyphSolanaBook }) {
  const age = Math.max(0, Math.round((Date.now() - book.at) / 1000))
  // A depth figure equal to the outermost rung was never actually crossed —
  // the probe simply ran out of ladder — so it is a floor, and marked as one
  // rather than left to read as an exact measurement.
  const isFloor = (v: number | null) => v != null && v >= book.ladderTopUsd
  return (
    <>
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Stat label="MID" value={fmtPx(book.mid)} color={paletteVar("cyph")} />
        <Stat
          label="SPREAD"
          value={
            book.spreadBps != null
              ? `${book.spreadBps.toFixed(0)} BPS`
              : "—"
          }
          tip={`Round-trip cost on a ${fmtCompactUSD(book.touchNotionalUsd)} trade. An AMM's spread grows with size, so it is quoted at the size it was measured at rather than as a single number.`}
        />
        <Stat
          label="DEPTH ±1%"
          value={`${fmtDepth(book.depth1PctUsd.bid, isFloor(book.depth1PctUsd.bid))} / ${fmtDepth(book.depth1PctUsd.ask, isFloor(book.depth1PctUsd.ask))}`}
          tip="Sell / buy notional that fills before the average price is 1% away from mid. A plus sign means the probe never reached that far, so the figure is a floor."
        />
        <Stat
          label="POOL LIQ"
          value={
            book.totalLiquidityUsd != null
              ? fmtCompactUSD(book.totalLiquidityUsd)
              : "—"
          }
          tip="Total value locked across the CYPH pools, per DexScreener. Both sides of each pool, so roughly twice the one-way depth."
        />
      </div>

      <Ladder book={book as BookLike} />

      <DepthCurve
        book={book as BookLike}
        height={92}
        fallback={
          <div
            className="mt-3 text-[10px]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            Not enough routable size to draw a curve.
          </div>
        }
      />

      <div className="mt-3 flex items-baseline justify-between gap-2 text-[9px] tabular-nums tracking-[0.14em]">
        <span style={{ color: paletteVar("cyph") }}>
          {fmtCompactNumber(book.bidShares)} BID
        </span>
        <span style={{ color: paletteVar("text"), opacity: 0.5 }}>
          {book.volume24hUsd != null
            ? `${fmtCompactUSD(book.volume24hUsd)} 24H VOL`
            : ""}
        </span>
        <span style={{ color: paletteVar("text"), opacity: 0.5 }}>
          {fmtCompactNumber(book.askShares)} ASK
        </span>
      </div>

      <div
        className="mt-3 text-[10px] leading-relaxed"
        style={{ color: paletteVar("text"), opacity: 0.55 }}
      >
        {WHAT_IT_IS} Probed {age < 90 ? `${age}s` : `${Math.round(age / 60)}m`} ago
        {book.pools.length > 0
          ? ` across ${book.pools.length} pool${book.pools.length === 1 ? "" : "s"}`
          : ""}
        .
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// CyphSolanaDepthPanel — the dedicated tile on /holdings → MARKET DEPTH.
// ---------------------------------------------------------------------------

export function CyphSolanaDepthPanel({ className }: { className?: string }) {
  const live = useTokenMarketIsLive()
  const { data, error, isLoading } = useCyphSolanaDepth(live)

  // Hidden entirely while a US venue is printing: the Nasdaq book above is
  // the market then, and this panel would be a second book competing with it.
  // The same predicate drives the tile's 24x7 badge, so the two surfaces turn
  // on and off together.
  if (!live) return null

  if (!data?.book) {
    // No skeleton on a hard failure — the equity book is still on the page
    // and an error box under it would be the only thing here that is broken.
    if (error || !isLoading) return null
    return (
      <CornerBox
        label="24×7 ORDER BOOK"
        color={paletteVar("cyph")}
        className={className}
      >
        <Skeleton className="mt-2" height={240} />
      </CornerBox>
    )
  }

  return (
    <CornerBox
      label="24×7 ORDER BOOK"
      color={paletteVar("cyph")}
      className={className}
      action={<SolanaBookBadge book={data.book} />}
    >
      <div
        className="mt-1 flex items-center gap-1 text-[10px]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        <span>
          Tokenized CYPH share on Solana — the only CYPH market open right now.
        </span>
        <InfoTip label="24x7 order book" align="left">
          {WHAT_IT_IS}
        </InfoTip>
      </div>
      <SolanaBookBody book={data.book} />
    </CornerBox>
  )
}
