/**
 * Zcash theoretical mining-emission curve.
 *
 * Parameters:
 *   - Genesis: 2016-10-28
 *   - Max supply: 21,000,000 ZEC
 *   - Bitcoin-like four-year halving cadence
 *
 * Returns monthly points from genesis through terminal supply, with an exact
 * point for today inserted. This is a display curve, not a block explorer.
 */

const GENESIS_MS = Date.UTC(2016, 9, 28) // 2016-10-28
const DAY_MS = 24 * 60 * 60 * 1000
const EPOCH_MS = 365.2425 * 4 * DAY_MS
const TERMINAL_EPOCHS = 34
export const ZEC_MAX_SUPPLY = 21_000_000

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function monthStartMs(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)
}

function cumulativeSupplyAtMs(ms: number): number {
  if (ms <= GENESIS_MS) return 0

  let total = 0
  for (let epoch = 0; epoch < TERMINAL_EPOCHS; epoch++) {
    const start = GENESIS_MS + epoch * EPOCH_MS
    const end = start + EPOCH_MS
    if (ms <= start) break

    const epochIssuance = ZEC_MAX_SUPPLY / 2 ** (epoch + 1)
    const elapsed = Math.min(ms, end) - start
    total += epochIssuance * Math.max(0, Math.min(1, elapsed / EPOCH_MS))
  }

  return Math.min(ZEC_MAX_SUPPLY, total)
}

export interface EmissionPoint {
  date: string // YYYY-MM-DD
  supply: number
  today?: boolean
}

export function getZecEmissionCurve(): EmissionPoint[] {
  const now = Date.now()
  const endMs = GENESIS_MS + TERMINAL_EPOCHS * EPOCH_MS
  const points = new Map<string, EmissionPoint>()

  const put = (ms: number, today = false) => {
    const date = isoDate(ms)
    points.set(date, {
      date,
      supply: cumulativeSupplyAtMs(ms),
      today,
    })
  }

  put(GENESIS_MS)
  for (let ms = monthStartMs(GENESIS_MS); ms <= endMs; ms = addMonths(ms, 1)) {
    if (ms >= GENESIS_MS) put(ms)
  }
  put(now, true)
  put(endMs)

  return [...points.values()].sort(
    (a, b) => Date.parse(a.date) - Date.parse(b.date)
  )
}
