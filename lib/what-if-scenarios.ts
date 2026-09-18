export const WHAT_IF_TIERS = {
  btc: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
  offshore: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
  globalEconomy: [
    0.0005, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1,
  ],
  gold: [0.0005, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
  stables: [0.05, 0.1, 0.25, 0.5, 1],
  doge: [1, 2, 5, 10, 20, 50, 100],
} as const

/**
 * Drop scenarios that are worth less than ZEC's live price, then take enough
 * higher tiers to preserve the section's intended row count. Before live
 * pricing arrives, retain the original lowest tiers so loading layouts do not
 * jump or collapse. If the configured ladder is exhausted, continue with
 * progressively higher 1×/2×/5× tiers rather than shrinking the section.
 */
export function selectUpsideRows<T extends { multiple: number | null }>(
  tiers: readonly number[],
  rowCount: number,
  buildRow: (tier: number) => T
): T[] {
  const candidates = tiers.map(buildRow)
  const hasLiveMultiples = candidates.some(
    (row) => row.multiple != null && Number.isFinite(row.multiple)
  )
  if (!hasLiveMultiples) return candidates.slice(0, rowCount)

  const upsideRows = candidates.filter(
    (row) =>
      row.multiple != null &&
      Number.isFinite(row.multiple) &&
      row.multiple >= 1
  )
  let nextTier = tiers.at(-1) ?? 1

  // A finite live multiple scales linearly with its tier. Advancing through
  // 64 additional 1/2/5 steps provides ample headroom while still guarding
  // against malformed upstream numbers or accidental infinite loops.
  for (
    let attempts = 0;
    upsideRows.length < rowCount && attempts < 64;
    attempts++
  ) {
    nextTier = nextScenarioTier(nextTier)
    if (!Number.isFinite(nextTier)) break

    const row = buildRow(nextTier)
    if (
      row.multiple != null &&
      Number.isFinite(row.multiple) &&
      row.multiple >= 1
    ) {
      upsideRows.push(row)
    }
  }

  return upsideRows.slice(0, rowCount)
}

function nextScenarioTier(tier: number): number {
  if (!Number.isFinite(tier) || tier <= 0) return 1

  const magnitude = 10 ** Math.floor(Math.log10(tier))
  const normalized = tier / magnitude
  if (normalized < 2) return 2 * magnitude
  if (normalized < 5) return 5 * magnitude
  return 10 * magnitude
}

export function formatScenarioShare(share: number): string {
  const pct = share * 100
  if (pct >= 1) return `${pct.toFixed(0)}%`
  if (pct >= 0.1) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(2)}%`
}
