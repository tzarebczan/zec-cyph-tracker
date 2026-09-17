// Cypherpunk Mining estimates.
//
// Cypherpunk discloses three things about the mining business:
//
//   1. Capital deployed — a single `MINING` row in the treasury list,
//      $33.33M dated 2026-08-18, read live via lib/cypherpunk-site.ts.
//   2. Fleet hashrate — a "// CYPHERPUNK FLEET" tile on cypherpunk.com's
//      mining section, quoted in GSol/s. A constant below; see the note.
//   3. ZEC mined — since 2026-08-31, a `mined` ZEC row per reporting period
//      (3,023.13 ZEC for 2026-08-18..31). Also read live.
//
// The disclosure is the anchor. Combined with the network's daily block count
// and hashrate over the same days (cipherscan, via /api/zec-mining), it yields
// the fleet's *implied* share of the network and hence an implied hashrate —
// a figure calibrated on what the fleet actually earned rather than on a
// marketing tile. Everything after the last disclosure is then that implied
// hashrate run forward through each day's real network hashrate, plus a
// partial day at the live figure. The stated fleet size is kept for
// comparison and as the fallback when no disclosure or no history exists.
//
// Everything derived is an estimate and must be labelled as one. Implied
// hashrate assumes the fleet has been the same size since the period it was
// calibrated on, and that Cypherpunk's disclosed period boundaries are the
// calendar days we infer (start of the outlay date through the row's date).

/** Fleet hashrate in GSol/s, as stated on cypherpunk.com's mining section.
 *
 *  Not a live read: it is absent from the homepage RSC payload (which carries
 *  only `networkHashrate` and a network `hashrateHistory`), the
 *  `/api/treasury-transactions` collection 403s, and the tile server-renders
 *  as "0.0 GSOL/S" because it is a client-side count-up whose target lives in
 *  a bundle we could not enumerate. Update it by reading the site. */
export const CYPH_FLEET_GSOL_S = 4.2

/** When the figure above was last checked against the site. */
export const CYPH_FLEET_OBSERVED_AT = "2026-08-19"

/** Equihash solutions per second in one GSol/s. */
const SOLS_PER_GSOL = 1_000_000_000
const DAY_MS = 86_400_000

/** One UTC day of network mining history. */
export interface ZecMiningDay {
  /** YYYY-MM-DD, UTC. */
  date: string
  /** Blocks found that day. */
  blocks: number
  /** Average network hashrate that day, raw Sol/s. */
  hashrateSolS: number | null
  difficulty: number | null
}

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
  /** Daily history, oldest first. May be empty when the upstream is down. */
  history: ZecMiningDay[]
}

/** A published ZEC-mined figure and the period it covers (inclusive days). */
export interface MinedDisclosure {
  zec: number
  from: string
  to: string
  days: number
}

/** One day of the estimated-production series behind the mining charts. */
export interface CyphMiningDayPoint {
  date: string
  /** ZEC credited to the fleet that day: official figures spread evenly over
   *  their period, estimates elsewhere. */
  zec: number
  /** Running total through this day. */
  cumulative: number
  /** Whether the day is inside an official disclosure period. */
  official: boolean
  networkGSolS: number | null
}

export interface CyphMiningEstimate {
  /** Fleet size as stated on cypherpunk.com. */
  fleetGSolS: number
  fleetObservedAt: string
  /** Fleet size implied by the official mined figure against the network's
   *  real block count and hashrate over the same days. Null without a
   *  disclosure or without history covering it. */
  impliedFleetGSolS: number | null
  /** Which fleet figure the forward estimate runs on. */
  basis: "disclosure" | "stated"
  /** The fleet figure actually used for every forward estimate. */
  effectiveFleetGSolS: number
  networkGSolS: number | null
  /** Effective fleet as a share of live network hashrate, in percent. */
  sharePct: number | null
  /** ZEC earned per GSol/s per day at the current network state. */
  zecPerGSolPerDay: number | null
  /** Run-rate: ZEC the fleet earns over a full day at current difficulty. */
  estZecPerDay: number | null
  /** Run-rate scaled by how much of the current UTC day has elapsed. */
  estZecToday: number | null
  /** Published figures, oldest first. */
  disclosures: MinedDisclosure[]
  /** Sum of the published figures. */
  officialZec: number
  /** Last day an official figure covers, or null. */
  officialThrough: string | null
  /** Average ZEC/day across all official periods, or null. */
  officialZecPerDay: number | null
  /** Estimated ZEC mined from the day after `officialThrough` to now. With no
   *  disclosure, this is the whole estimate since `startedAt`. */
  estZecSinceOfficial: number | null
  /** Days the estimate covers (fractional). */
  estDaysSinceOfficial: number | null
  /** Official plus estimate since — the headline "mined to date". */
  totalZecToDate: number | null
  /** Whole days plus fraction since mining went live. */
  daysLive: number | null
  startedAt: string | null
  /** Daily series from `startedAt` through today, for charts. */
  series: CyphMiningDayPoint[]
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/** Fleet share of the network implied by one disclosure: ZEC mined ÷ ZEC the
 *  network paid miners over the same days, then × the period's average
 *  hashrate. Requires history for every day in the period. */
function impliedFleetFromDisclosure(
  disclosure: MinedDisclosure,
  byDay: Map<string, ZecMiningDay>,
  minerRewardPerBlock: number
): number | null {
  let paidZec = 0
  let hashSum = 0
  let n = 0
  for (let ms = dayMs(disclosure.from); ms <= dayMs(disclosure.to); ms += DAY_MS) {
    const day = byDay.get(utcDay(ms))
    if (!day || day.hashrateSolS == null || day.blocks <= 0) return null
    paidZec += day.blocks * minerRewardPerBlock
    hashSum += day.hashrateSolS
    n++
  }
  if (n === 0 || paidZec <= 0) return null
  const share = disclosure.zec / paidZec
  return (share * (hashSum / n)) / SOLS_PER_GSOL
}

export function estimateCyphMining({
  network,
  startedAt,
  now,
  disclosures = [],
  fleetGSolS = CYPH_FLEET_GSOL_S,
}: {
  network: ZecMiningNetwork
  /** Disclosed mining start, from the treasury MINING row. */
  startedAt: string | null
  now: number
  /** Published ZEC-mined figures, oldest first. */
  disclosures?: MinedDisclosure[]
  fleetGSolS?: number
}): CyphMiningEstimate {
  const history = network.history ?? []
  const byDay = new Map(history.map((d) => [d.date, d]))
  const minerReward = network.minerRewardPerBlock ?? 1.25

  // Calibrate on the most recent disclosure the history can cover: a later
  // period reflects the fleet as it is now better than an earlier one.
  let impliedFleetGSolS: number | null = null
  for (let i = disclosures.length - 1; i >= 0 && impliedFleetGSolS == null; i--) {
    impliedFleetGSolS = impliedFleetFromDisclosure(disclosures[i], byDay, minerReward)
  }
  const basis: CyphMiningEstimate["basis"] =
    impliedFleetGSolS != null ? "disclosure" : "stated"
  const effectiveFleetGSolS = impliedFleetGSolS ?? fleetGSolS

  const networkGSolS =
    network.networkSolS != null && network.networkSolS > 0
      ? network.networkSolS / SOLS_PER_GSOL
      : null
  const sharePct =
    networkGSolS != null && networkGSolS > 0
      ? (effectiveFleetGSolS / networkGSolS) * 100
      : null
  const daily = network.dailyMinerRevenueZec
  const zecPerGSolPerDay =
    daily != null && networkGSolS != null && networkGSolS > 0
      ? daily / networkGSolS
      : null
  const estZecPerDay =
    daily != null && sharePct != null ? daily * (sharePct / 100) : null

  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const startDay = Number.isFinite(startedMs) ? utcDay(startedMs) : null
  const daysLive = startDay != null
    ? Math.max(0, (now - dayMs(startDay)) / DAY_MS)
    : null

  const todayDay = utcDay(now)
  const dayFraction = Math.min(1, Math.max(0, (now - dayMs(todayDay)) / DAY_MS))
  const estZecToday = estZecPerDay != null ? estZecPerDay * dayFraction : null

  const officialZec = disclosures.reduce((sum, d) => sum + d.zec, 0)
  const officialDays = disclosures.reduce((sum, d) => sum + d.days, 0)
  const officialThrough = disclosures.length
    ? disclosures[disclosures.length - 1].to
    : null
  const officialZecPerDay = officialDays > 0 ? officialZec / officialDays : null

  // Estimated ZEC for one past UTC day, from the fleet's share of that day's
  // network at that day's real block count. Falls back to the live run-rate
  // when the history has no row for the day.
  const estForDay = (day: string): number | null => {
    const h = byDay.get(day)
    if (h && h.hashrateSolS != null && h.blocks > 0) {
      return (
        ((effectiveFleetGSolS * SOLS_PER_GSOL) / h.hashrateSolS) *
        h.blocks *
        minerReward
      )
    }
    return estZecPerDay
  }

  // Daily series from launch through today. Official periods are spread
  // evenly across their days (the disclosure gives a total, not a curve);
  // every other day is an estimate.
  const series: CyphMiningDayPoint[] = []
  let cumulative = 0
  let estSince = 0
  let estSinceDays = 0
  let haveEstimate = estZecPerDay != null
  if (startDay != null) {
    const estFrom = officialThrough != null ? utcDay(dayMs(officialThrough) + DAY_MS) : startDay
    for (let ms = dayMs(startDay); ms <= dayMs(todayDay); ms += DAY_MS) {
      const day = utcDay(ms)
      const disclosure = disclosures.find((d) => d.from <= day && day <= d.to)
      let zec: number
      let official = false
      if (disclosure) {
        zec = disclosure.zec / disclosure.days
        official = true
      } else if (day === todayDay) {
        zec = estZecToday ?? 0
      } else {
        const e = estForDay(day)
        if (e == null) haveEstimate = false
        zec = e ?? 0
      }
      if (!official && day >= estFrom) {
        estSince += zec
        estSinceDays += day === todayDay ? dayFraction : 1
      }
      cumulative += zec
      series.push({
        date: day,
        zec,
        cumulative,
        official,
        networkGSolS: byDay.get(day)?.hashrateSolS != null
          ? (byDay.get(day)!.hashrateSolS as number) / SOLS_PER_GSOL
          : null,
      })
    }
  }

  const estZecSinceOfficial = startDay != null && haveEstimate ? estSince : null
  const totalZecToDate =
    estZecSinceOfficial != null ? officialZec + estZecSinceOfficial : null

  return {
    fleetGSolS,
    fleetObservedAt: CYPH_FLEET_OBSERVED_AT,
    impliedFleetGSolS,
    basis,
    effectiveFleetGSolS,
    networkGSolS,
    sharePct,
    zecPerGSolPerDay,
    estZecPerDay,
    estZecToday,
    disclosures,
    officialZec,
    officialThrough,
    officialZecPerDay,
    estZecSinceOfficial,
    estDaysSinceOfficial: startDay != null ? estSinceDays : null,
    totalZecToDate,
    daysLive,
    startedAt,
    series,
  }
}
