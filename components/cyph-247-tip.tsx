"use client"

import { InfoTip } from "./primitives"
import { fmtCompactUSD } from "./format"
import type { QuoteSnapshot } from "./api-types"

/** Why the 24x7 price is nowhere near the Nasdaq close.
 *
 *  The tokenized share only tracks the share while someone can redeem it, and
 *  redemption needs a US session, so a weekend gap has nothing closing it.
 *  Rendered beside the asterisk on a dislocated print. */
export function Dislocation247Tip({
  quote,
  changePct,
  close,
}: {
  quote?: QuoteSnapshot | null
  changePct: number | null
  close: number | null
}) {
  const isPerp = quote?.tokenMarketSource === "gate-perp"
  const liq = quote?.tokenMarketLiquidityUsd
  const side = (changePct ?? 0) >= 0 ? "premium" : "discount"
  return (
    <InfoTip label="Why this differs from the Nasdaq price" size={11}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {changePct != null
          ? `${Math.abs(changePct).toFixed(0)}% ${side} to the last close`
          : `Away from the last close`}
      </div>
      {isPerp ? (
        <>
          The CYPH/USDT perpetual on Gate.io — a derivative, not a share. It
          tracks the stock through funding, so it can drift.
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
