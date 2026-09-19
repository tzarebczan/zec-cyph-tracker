"use client"

import { CornerBox, InfoTip, Skeleton } from "./primitives"
import { paletteVar, withAlpha } from "./theme"
import { fmtCompactNumber, fmtCompactUSD } from "./format"
import {
  DepthCurve,
  Ladder,
  Stat,
  useNasdaqBookAvailable,
  type BookLike,
} from "./cyph-depth"
import {
  useCyphSolanaDepth,
  useTokenMarketIsLive,
} from "./use-cyph-solana-depth"
import type { CyphSolanaBook } from "./api-types"

// Depth for the tokenized CYPH share on Solana — the market that is open when
// Nasdaq and Blue Ocean are not.
//
// The pools never close, but this surfaces in only two cases. The first is
// where the 24x7 price already takes over the headline: no US venue is
// printing, so the pools are where CYPH is trading. The second is whenever
// neither Nasdaq feed has a book to give — a bridge outage, a missing
// binding, a Databento gap — because a live on-chain book beats an empty
// panel, and the pools can always be asked.
//
// Otherwise it stays hidden. During a session with a healthy feed the Nasdaq
// book is the market that matters, and two books side by side would invite
// reading a pool's price against an exchange's.
//
// What the ladder is, and what the UI says out loud: an AMM has no resting
// orders. Each rung is the size fillable between the previous rung's average
// price and this one's, measured by quoting real routed trades. The
// cumulative depth that produces is genuine — it is what you could trade
// against right now — but nobody has committed to it, and the liquidity
// behind it can be withdrawn.

/** `40s`, `7m`, `3h`, `2d`. Coarsens as it grows so a payload retained across
 *  a weekend reads as days rather than as four digits of minutes. */
function fmtAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function fmtPx(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(2)}`
}

/** `$10k`, `$10k+` when the ladder never reached the band's edge so the
 *  figure is a floor, or `<$500` when the band is narrower than the smallest
 *  probe — which means the depth was not measured down there, not that there
 *  is none. */
function fmtDepth(
  usd: number | null,
  atCeiling: boolean,
  probeFloorUsd: number
): string {
  if (usd == null) return "—"
  if (usd <= 0) return `<${fmtCompactUSD(probeFloorUsd)}`
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
  // A depth figure equal to the outermost rung that survived was never
  // actually crossed — the probe ran out of ladder — so it is a floor, marked
  // as one rather than left to read as an exact measurement. Measured per
  // side, because the two ladders can truncate at different rungs.
  const isFloor = (v: number | null, side: "bid" | "ask") =>
    v != null && v >= book.probedTopUsd[side]
  return (
    <>
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Stat
          label="MID"
          value={fmtPx(book.mid)}
          color={paletteVar("cyph")}
          tip={`Midpoint of the two ${fmtCompactUSD(book.touchNotionalUsd)} probes. A pool has no quoted touch, so this is the midpoint of what a small trade each way would actually fill at — within about half a spread of spot, and so not identical to the headline price.`}
        />
        <Stat
          label="SPREAD"
          value={
            book.spreadBps != null
              ? `${book.spreadBps.toFixed(0)} BPS`
              : "—"
          }
          tip={`Gap between what a ${fmtCompactUSD(book.touchNotionalUsd)} buy and a ${fmtCompactUSD(book.touchNotionalUsd)} sell fill at, quoted a moment apart. An AMM's spread grows with size, so it travels with the size it was measured at rather than standing alone.`}
        />
        <Stat
          label="DEPTH ±1%"
          value={`${fmtDepth(book.depth1PctUsd.bid, isFloor(book.depth1PctUsd.bid, "bid"), book.touchNotionalUsd)} / ${fmtDepth(book.depth1PctUsd.ask, isFloor(book.depth1PctUsd.ask, "ask"), book.touchNotionalUsd)}`}
          tip={
            `Sell / buy notional that fills before the average price is 1% away from mid. ` +
            `Within 2%: ${fmtDepth(book.depth2PctUsd.bid, isFloor(book.depth2PctUsd.bid, "bid"), book.touchNotionalUsd)} sell / ` +
            `${fmtDepth(book.depth2PctUsd.ask, isFloor(book.depth2PctUsd.ask, "ask"), book.touchNotionalUsd)} buy. ` +
            `A plus sign means the probe never reached that far, so the figure is a floor.`
          }
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
        {WHAT_IT_IS} Probed {fmtAge(age)} ago
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
  // Two reasons to show, and they read differently to a user, so they are
  // tracked separately rather than collapsed into one boolean.
  const tokenIsMarket = useTokenMarketIsLive()
  const nasdaqAvailable = useNasdaqBookAvailable()
  const show = tokenIsMarket || !nasdaqAvailable
  const { data, error, isLoading } = useCyphSolanaDepth(show)

  // Hidden while a US venue is printing and its book is reaching us: that
  // book is the market then, and this would be a second one competing with
  // it. The first half of the condition is the same predicate that drives the
  // tile's 24x7 badge, so price and book turn on together.
  if (!show) return null

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
          {tokenIsMarket
            ? "Tokenized CYPH share on Solana — the only CYPH market open right now."
            : "Tokenized CYPH share on Solana. Shown because no Nasdaq book is reaching us; the pools trade around the clock."}
        </span>
        <InfoTip label="24x7 order book" align="left">
          {WHAT_IT_IS}
        </InfoTip>
      </div>
      <SolanaBookBody book={data.book} />
    </CornerBox>
  )
}
