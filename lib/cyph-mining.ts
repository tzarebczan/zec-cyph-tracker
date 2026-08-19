// Cypherpunk Mining estimates.
//
// Cypherpunk discloses two things about the mining business and nothing else:
//
//   1. Capital deployed — a single `MINING` row in the treasury list,
//      $33.33M dated 2026-08-18, which we read live via lib/cypherpunk-site.ts.
//   2. Fleet hashrate — a "// CYPHERPUNK FLEET" tile on cypherpunk.com's
//      mining section, quoted in GSol/s.
//
// The fleet figure is the constant below rather than a live read, because it is
// not obtainable programmatically: it is absent from the homepage RSC payload
// (which carries only `networkHashrate` and a network `hashrateHistory`), the
// `/api/treasury-transactions` collection 403s, and the tile server-renders as
// "0.0 GSOL/S" because it is a client-side count-up whose target lives in a
// bundle we could not enumerate. Update it by reading the site.
//
// Everything derived from it is an estimate and must be labelled as one. It
// assumes the fleet has run at its current size since day one and that network
// hashrate has been flat, neither of which is true.

/** Fleet hashrate in GSol/s, as stated on cypherpunk.com's mining section. */
export const CYPH_FLEET_GSOL_S = 4.2

/** When the figure above was last checked against the site. */
export const CYPH_FLEET_OBSERVED_AT = "2026-08-19"

/** Equihash solutions per second in one GSol/s. */
const SOLS_PER_GSOL = 1_000_000_000

export interface ZecMiningNetwork {
  /** Network hashrate in raw Sol/s. */
  networkSolS: number | null
  /** ZEC paid to miners per block (excludes funding streams and lockbox). */
  minerRewardPerBlock: number | null
  /** Network-wide ZEC to miners per day. */
  dailyMinerRevenueZec: number | null
  blocks24h: number | null
  avgBlockTimeSecs: number | null
  difficulty: number | null
}

export interface CyphMiningEstimate {
  fleetGSolS: number
  fleetObservedAt: string
  networkGSolS: number | null
  /** Fleet as a share of network hashrate, in percent. */
  sharePct: number | null
  /** ZEC earned per GSol/s per day at the current network state — the figure
   *  that makes the fleet number meaningful on its own. */
  zecPerGSolPerDay: number | null
  /** Run-rate: ZEC the fleet earns over a full day at current difficulty. */
  estZecPerDay: number | null
  /** Run-rate scaled by how much of the current UTC day has elapsed. */
  estZecToday: number | null
  /** Cumulative since the disclosed start date. Roughest of the figures —
   *  assumes a constant fleet and a flat network across the whole period. */
  estZecToDate: number | null
  /** Whole days plus fraction since mining went live. */
  daysLive: number | null
  startedAt: string | null
}

export function estimateCyphMining({
  network,
  startedAt,
  now,
  fleetGSolS = CYPH_FLEET_GSOL_S,
}: {
  network: ZecMiningNetwork
  /** Disclosed mining start, from the treasury MINING row. */
  startedAt: string | null
  now: number
  fleetGSolS?: number
}): CyphMiningEstimate {
  const networkGSolS =
    network.networkSolS != null && network.networkSolS > 0
      ? network.networkSolS / SOLS_PER_GSOL
      : null
  const sharePct =
    networkGSolS != null && networkGSolS > 0
      ? (fleetGSolS / networkGSolS) * 100
      : null
  const daily = network.dailyMinerRevenueZec
  const zecPerGSolPerDay =
    daily != null && networkGSolS != null && networkGSolS > 0
      ? daily / networkGSolS
      : null
  const estZecPerDay =
    daily != null && sharePct != null ? daily * (sharePct / 100) : null

  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const daysLive = Number.isFinite(startedMs)
    ? Math.max(0, (now - startedMs) / 86_400_000)
    : null

  // Fraction of the current UTC day elapsed, so "today" is a partial-day
  // figure rather than a full-day run-rate pretending to be one.
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate()
  )
  const dayFraction = Math.min(1, Math.max(0, (now - dayStart) / 86_400_000))

  return {
    fleetGSolS,
    fleetObservedAt: CYPH_FLEET_OBSERVED_AT,
    networkGSolS,
    sharePct,
    zecPerGSolPerDay,
    estZecPerDay,
    estZecToday: estZecPerDay != null ? estZecPerDay * dayFraction : null,
    estZecToDate:
      estZecPerDay != null && daysLive != null ? estZecPerDay * daysLive : null,
    daysLive,
    startedAt,
  }
}
