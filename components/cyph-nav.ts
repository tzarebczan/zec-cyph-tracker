// ──────────────────────────────────────────────────────────────────────
// CYPH share structure + NAV-per-share math — one source of truth shared
// by the dashboard tile and the /holdings treasury card so the two
// surfaces can never disagree.
//
// WHY THIS EXISTS
// mNAV as cypherpunk.com reports it is Enterprise Value ÷ Net Asset Value,
// where their EV folds in "proforma net cash" over a diluted share base we
// can't reconstruct from public data. We deliberately DON'T try to
// reproduce that number — we surface cypherpunk's published mNAV as-is
// (clearly sourced), and separately compute our OWN transparent NAV per
// share straight from the live ZEC treasury value ÷ CYPH's share counts.
//
// SHARE COUNTS are not in any live feed, so the common base + each dilutive
// tranche (with its strike) are pinned here from CYPH's SEC filing. The
// diluted count is derived per-render from the LIVE price so it stays on
// the same as-of basis as the common shares and reacts if the price crosses
// a strike (e.g. options in the money after a big rally). Refresh the
// tranches when a new 10-Q / 10-K lands.
//   Source: Form 10-Q, quarter ended March 31, 2026 (SEC EDGAR), Notes 8
//   (Warrants) & 9 (Equity Incentive Plans), plus subsequent-events
//   disclosures through May 13, 2026. Common O/S is the 10-Q cover-page
//   figure as of May 12, 2026.
// ──────────────────────────────────────────────────────────────────────

/** A dilutive instrument. `strike: null` = always dilutive on vest (RSUs). */
interface DilutiveTranche {
  label: string
  shares: number
  strike: number | null
}

export const CYPH_SHARE_STRUCTURE = {
  asOf: "2026-05-12",
  /** Common stock outstanding (10-Q cover page). */
  commonOutstanding: 106_464_482,
  /**
   * Every dilutive instrument outstanding, with its strike. A tranche
   * counts toward the diluted share base only when it's in the money at the
   * live price (RSUs always). At the current ~$0.65 price everything except
   * the March 2020 coverage warrants ($21.10) and employee options ($7.46)
   * is in the money.
   */
  dilutiveTranches: [
    { label: "Oct 2025 pre-funded warrants", shares: 80_768_504, strike: 0.001 },
    { label: "Oct 2025 common warrants (investors)", shares: 71_985_605, strike: 0.5335 },
    { label: "Oct 2025 common warrants (placement)", shares: 4_000_000, strike: 0.5335 },
    { label: "Jan 2017 warrants", shares: 5_450, strike: 0.1 },
    { label: "RSUs (unvested)", shares: 16_681_971, strike: null },
    { label: "Mar 2020 coverage warrants", shares: 1_921_854, strike: 21.1 },
    { label: "Stock options", shares: 3_757_238, strike: 7.46 },
  ] as DilutiveTranche[],
} as const

// When the live price is unavailable (quote rate-limited), classify tranches
// as ITM against this reference so NAV/share still renders. $1 captures the
// sub-dollar warrants + RSUs and excludes the $7.46 / $21.10 tranches —
// i.e. today's ITM set.
const ITM_FALLBACK_PRICE = 1

/** Diluted share count = common + every tranche in the money at `price`. */
function itmDilutedShares(commonShares: number, price: number): number {
  return CYPH_SHARE_STRUCTURE.dilutiveTranches.reduce(
    (sum, t) => (t.strike == null || price >= t.strike ? sum + t.shares : sum),
    commonShares
  )
}

export interface CyphNav {
  /** NAV per share on the common shares outstanding. */
  navPerShareOS: number | null
  /** NAV per share on the ITM-diluted share count. */
  navPerShareDiluted: number | null
  /** Live price vs O/S NAV, signed %: negative = below NAV (discount),
   *  positive = above NAV (premium). */
  vsNavOSPct: number | null
  /** Live price vs diluted NAV, signed % (same sign convention). */
  vsNavDilutedPct: number | null
  /** Common share count actually used (live if available, else filing). */
  commonShares: number
  /** Diluted (ITM) share count used. */
  dilutedShares: number
}

/**
 * Compute CYPH's transparent NAV-per-share metrics from the live ZEC
 * treasury value and CYPH's share counts. Prefers a live common-shares
 * figure (Yahoo updates it from filings) and falls back to the pinned
 * filing count so the O/S NAV still renders when the quote is unavailable.
 * The diluted count is built on the SAME common base + the tranches that are
 * in the money at the live price, so the two NAVs never mix as-of bases.
 */
export function computeCyphNav({
  treasuryUsd,
  cyphPrice,
  commonSharesLive,
}: {
  treasuryUsd: number | null
  cyphPrice: number | null
  commonSharesLive?: number | null
}): CyphNav {
  const commonShares =
    commonSharesLive != null && commonSharesLive > 0
      ? commonSharesLive
      : CYPH_SHARE_STRUCTURE.commonOutstanding
  const classifyPrice =
    cyphPrice != null && cyphPrice > 0 ? cyphPrice : ITM_FALLBACK_PRICE
  const dilutedShares = itmDilutedShares(commonShares, classifyPrice)

  const navPerShareOS =
    treasuryUsd != null && commonShares > 0 ? treasuryUsd / commonShares : null
  const navPerShareDiluted =
    treasuryUsd != null && dilutedShares > 0 ? treasuryUsd / dilutedShares : null

  const vsNav = (nav: number | null) =>
    cyphPrice != null && nav != null && nav > 0
      ? (cyphPrice / nav - 1) * 100
      : null

  return {
    navPerShareOS,
    navPerShareDiluted,
    vsNavOSPct: vsNav(navPerShareOS),
    vsNavDilutedPct: vsNav(navPerShareDiluted),
    commonShares,
    dilutedShares,
  }
}
