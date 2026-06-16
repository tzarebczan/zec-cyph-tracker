/**
 * Zcash theoretical mining-emission curve.
 *
 * Parameters:
 *   - Genesis: 2016-10-28
 *   - Target block time: 75 seconds
 *   - Slow start: 20,000 blocks with reward ramping 0 → 12.5 ZEC
 *   - Halving interval: 1,046,400 blocks
 *   - Initial post-slow-start subsidy: 12.5 ZEC
 *
 * Returns one point per UTC day from genesis through today.
 */

const GENESIS_MS = Date.UTC(2016, 9, 28) // 2016-10-28
const BLOCK_TIME_MS = 75 * 1000
const SLOW_START_BLOCKS = 20_000
const HALVING_INTERVAL = 1_046_400
const INITIAL_SUBSIDY = 12.5

function blockSubsidy(height: number): number {
  if (height < 0) return 0
  if (height < SLOW_START_BLOCKS) {
    // Linear ramp from 0 to 12.5 ZEC over the slow-start window.
    return (height / SLOW_START_BLOCKS) * INITIAL_SUBSIDY
  }
  const halvings = Math.floor(
    (height - SLOW_START_BLOCKS) / HALVING_INTERVAL
  )
  // Subsidy drops to zero once halvings would push it below the smallest
  // representable increment (ZEC has 8 decimals).
  if (halvings >= 54) return 0
  return INITIAL_SUBSIDY / Math.pow(2, halvings)
}

function cumulativeSupplyAtHeight(height: number): number {
  if (height < 0) return 0
  // Slow-start sum is a triangular series.
  const slowEnd = Math.min(height, SLOW_START_BLOCKS - 1)
  const slowStartSum =
    (slowEnd * (slowEnd + 1)) / 2 / SLOW_START_BLOCKS * INITIAL_SUBSIDY

  if (height < SLOW_START_BLOCKS) return slowStartSum

  let total = slowStartSum
  let h = SLOW_START_BLOCKS

  // Add full halving epochs.
  while (h <= height) {
    const halvings = Math.floor((h - SLOW_START_BLOCKS) / HALVING_INTERVAL)
    if (halvings >= 54) break
    const epochStart =
      SLOW_START_BLOCKS + halvings * HALVING_INTERVAL
    const epochEnd = Math.min(height, epochStart + HALVING_INTERVAL - 1)
    const blocksInEpoch = epochEnd - epochStart + 1
    total += blocksInEpoch * (INITIAL_SUBSIDY / Math.pow(2, halvings))
    h = epochEnd + 1
  }

  return total
}

export interface EmissionPoint {
  date: string // YYYY-MM-DD
  supply: number
}

export function getZecEmissionCurve(): EmissionPoint[] {
  const now = Date.now()
  const daysSinceGenesis = Math.floor(
    (now - GENESIS_MS) / (24 * 60 * 60 * 1000)
  )
  const out: EmissionPoint[] = []
  for (let d = 0; d <= daysSinceGenesis; d++) {
    const ms = GENESIS_MS + d * 24 * 60 * 60 * 1000
    const height = Math.floor((ms - GENESIS_MS) / BLOCK_TIME_MS)
    out.push({
      date: new Date(ms).toISOString().slice(0, 10),
      supply: cumulativeSupplyAtHeight(height),
    })
  }
  return out
}
