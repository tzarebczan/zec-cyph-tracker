"use client"

import { InfoTip } from "./primitives"
import { fmtCompactUSD } from "./format"
import { paletteVar } from "./theme"
import { isDislocated247, type LiveCyphSessionDetail } from "./quote-utils"
import type { QuoteSnapshot } from "./api-types"

/** Why the 24x7 price is nowhere near the Nasdaq price.
 *
 *  The tokenized share only tracks the share while someone can redeem it, and
 *  redemption needs a US session, so a gap has nothing closing it until one
 *  opens. Rendered beside the asterisk on a dislocated print — as the headline
 *  when no US venue is trading (`mode="headline"`), or beside a live US print
 *  when one is (`mode="aside"`), where there are two live prices on the tile
 *  and the tip has to say which is which. */
export function Dislocation247Tip({
  quote,
  changePct,
  close,
  mode = "headline",
  sessionLabel,
  sessionPrice,
  price,
}: {
  quote?: QuoteSnapshot | null
  changePct: number | null
  close: number | null
  mode?: "headline" | "aside"
  /** Badge of the US session printing alongside — "OVN", "PRE", "AFT", "OPEN". */
  sessionLabel?: string
  /** That session's price, for the gap the reader is actually looking at. */
  sessionPrice?: number | null
  /** The 24x7 price itself, needed to measure against `sessionPrice`. */
  price?: number | null
}) {
  const isPerp = quote?.tokenMarketSource === "gate-perp"
  const liq = quote?.tokenMarketLiquidityUsd
  const side = (changePct ?? 0) >= 0 ? "premium" : "discount"
  // Against the live US print when there is one: that is the comparison on
  // screen. The close still appears below, since it is what the % is measured
  // from everywhere else on the site.
  const vsSession =
    mode === "aside" &&
    price != null &&
    sessionPrice != null &&
    sessionPrice > 0
      ? ((price - sessionPrice) / sessionPrice) * 100
      : null
  return (
    <InfoTip label="Why this differs from the Nasdaq price" size={11}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {vsSession != null && sessionLabel
          ? `${Math.abs(vsSession).toFixed(0)}% ${
              vsSession >= 0 ? "premium" : "discount"
            } to the ${sessionLabel} print`
          : changePct != null
            ? `${Math.abs(changePct).toFixed(0)}% ${side} to the last close`
            : `Away from the last close`}
      </div>
      {isPerp ? (
        <>
          The CYPH/USDT perpetual on Gate.io — a derivative, not a share. It
          tracks the stock through funding, so it can drift.
        </>
      ) : mode === "aside" ? (
        <>
          A different market from Nasdaq: the tokenized CYPH share on Solana,
          trading around the clock alongside the US session. It redeems 1:1 for
          the share, but only through a US broker — so the two prices can part
          company and stay apart.
        </>
      ) : (
        <>
          A different market from Nasdaq: the tokenized CYPH share on Solana,
          the only CYPH venue open right now. It redeems 1:1 for the share —
          but only during a US session, so nothing arbitrages the gap while
          Nasdaq is shut.
        </>
      )}
      <div style={{ marginTop: 4, opacity: 0.75 }}>
        {[
          quote?.tokenMarketVenue,
          liq != null ? `~${fmtCompactUSD(liq)} total liquidity` : null,
          close != null ? `Nasdaq close $${close.toFixed(2)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </InfoTip>
  )
}

/** Says that a portfolio total is valued at the 24x7 price.
 *
 *  The dashboard's PORT tile and /portfolio both value CYPH at whatever the
 *  headline is, which between sessions is the Solana print — so a weekend
 *  total can sit well away from the Nasdaq mark. /portfolio has room to say so
 *  in its caption; the tile does not, so it gets this one line. Shared with
 *  the tip so both surfaces call the same thing by the same name. */
export function Cyph247ValuationNote({
  quote,
  detail,
}: {
  quote?: QuoteSnapshot | null
  detail: LiveCyphSessionDetail
}) {
  if (detail.session !== "24X7" || detail.price == null) return null
  const dislocated = isDislocated247(detail.changePct)
  return (
    <div
      className="mt-1 flex items-center gap-1 text-[10px] leading-none tabular-nums"
      style={{ color: paletteVar("text"), opacity: 0.62 }}
    >
      <span className="tracking-[0.12em] font-bold">CYPH @ 24x7</span>
      <span style={{ color: paletteVar("cyph"), opacity: 0.9 }}>
        ${detail.price.toFixed(2)}
        {dislocated ? "*" : ""}
      </span>
      {dislocated && (
        <Dislocation247Tip
          quote={quote}
          changePct={detail.changePct}
          close={detail.prevClose}
        />
      )}
    </div>
  )
}
