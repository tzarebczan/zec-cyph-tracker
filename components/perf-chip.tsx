/**
 * Tiny pill that shows a percentage change for a labeled period.
 * Used in stat cards to surface 7d / 30d / 90d performance and ratio
 * vs-average windows without crowding the headline price.
 */
export function PerfChip({
  label,
  pct,
  inverted = false,
}: {
  label: string
  /** Percentage change. null renders a neutral em-dash chip. */
  pct: number | null
  /** When true, negative is "good" (green) — used for "vs avg" where below
   *  the average can be interpreted as a buying opportunity. Default off. */
  inverted?: boolean
}) {
  if (pct == null) {
    return (
      <span className="px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground text-[10px] font-mono whitespace-nowrap">
        {label} —
      </span>
    )
  }
  const isUp = pct >= 0
  const positive = inverted ? !isUp : isUp
  const cls = positive
    ? "border-green-500/30 text-green-400 bg-green-500/5"
    : "border-red-500/30 text-red-400 bg-red-500/5"
  // Format: keep one decimal for typical equity moves, but bump to two when
  // the value is small enough that rounding would hide direction.
  const fmt = Math.abs(pct) < 0.1 ? pct.toFixed(2) : pct.toFixed(1)
  return (
    <span
      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap ${cls}`}
    >
      {label} {isUp ? "+" : ""}
      {fmt}%
    </span>
  )
}
