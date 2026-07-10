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
// SHARE COUNTS are not in any live feed, so they're pinned here from CYPH's
// SEC filing. Refresh when a new 10-Q / 10-K lands.
//   Source: Form 10-Q, quarter ended March 31, 2026 (SEC EDGAR), Notes 8
//   (Warrants) & 9 (Equity Incentive Plans), plus subsequent-events
//   disclosures through May 13, 2026. Common O/S is the 10-Q cover-page
//   figure as of May 12, 2026.
// ──────────────────────────────────────────────────────────────────────

export const CYPH_SHARE_STRUCTURE = {
  asOf: "2026-05-12",
  /** Common stock outstanding (10-Q cover page). */
  commonOutstanding: 106_464_482,
  /** Sum of common + every warrant/option/RSU line. */
  fullyDiluted: 285_585_104,
  /**
   * ITM-diluted: common + only the in-the-money warrants + RSUs. Excludes
   * the deeply-OTM March 2020 coverage warrants ($21.10 strike) and
   * employee options ($7.46 wtd-avg strike). At the current ~$0.65 price
   * almost everything else is in the money, so this sits within ~2% of the
   * fully-diluted total — but it's the economically honest denominator for
   * "how many shares would actually convert today."
   */
  itmDiluted: 279_906_012,
} as const

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
  const dilutedShares = CYPH_SHARE_STRUCTURE.itmDiluted

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
