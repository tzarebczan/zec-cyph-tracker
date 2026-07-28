import type {
  IronwoodBlock,
  IronwoodMigrationTx,
} from "@/lib/ironwood-live"

export type IronwoodWindow =
  | "10M"
  | "30M"
  | "1H"
  | "6H"
  | "24H"
  | "7D"
  | "ALL"

export const WINDOW_MS: Record<Exclude<IronwoodWindow, "ALL">, number> = {
  "10M": 10 * 60_000,
  "30M": 30 * 60_000,
  "1H": 60 * 60_000,
  "6H": 6 * 60 * 60_000,
  "24H": 24 * 60 * 60_000,
  "7D": 7 * 24 * 60 * 60_000,
}

export function fmtZec(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "--"
  const isFractionalZec = value > 0 && value < 1
  const effectiveMaximum = isFractionalZec
    ? Math.max(4, maximumFractionDigits)
    : maximumFractionDigits
  return value.toLocaleString("en-US", {
    minimumFractionDigits: isFractionalZec ? 4 : 0,
    maximumFractionDigits: effectiveMaximum,
  })
}

export function fmtCompact(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "--"
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value)
}

export function fmtBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  if (value < 1_000) return `${Math.round(value)} B`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} KB`
}

export function shortHash(value: string, side = 6): string {
  if (value.length <= side * 2 + 1) return value
  return `${value.slice(0, side)}...${value.slice(-side)}`
}

export function ageLabel(timestampSeconds: number, now: number): string {
  if (!timestampSeconds) return "--"
  const seconds = Math.max(0, Math.floor((now - timestampSeconds * 1000) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatTime(
  timestampSeconds: number,
  options?: { zone?: string; includeDate?: boolean }
): string {
  if (!timestampSeconds) return "--"
  return new Intl.DateTimeFormat("en-US", {
    ...(options?.includeDate
      ? { month: "short" as const, day: "numeric" as const }
      : {}),
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    ...(options?.zone ? { timeZone: options.zone } : {}),
    timeZoneName: "short",
  })
    .format(new Date(timestampSeconds * 1000))
    .toUpperCase()
}

/** Short axis/tick label. `formatTime` carries seconds and a zone
 *  abbreviation, which is right for a footer timestamp but far too wide for
 *  a 9px SVG tick — three of those on one axis collide on narrow screens.
 *  Same-day ranges get `11:24 PM`; multi-day ranges add `JUL 27`. */
export function formatTick(
  timestampSeconds: number,
  options?: { includeDate?: boolean }
): string {
  if (!timestampSeconds) return "--"
  return new Intl.DateTimeFormat("en-US", {
    ...(options?.includeDate
      ? { month: "short" as const, day: "numeric" as const }
      : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(timestampSeconds * 1000))
    .toUpperCase()
}

export function formatActivationTime(timestamp: number, zone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    ...(zone ? { timeZone: zone } : {}),
    timeZoneName: "short",
  })
    .format(new Date(timestamp))
    .toUpperCase()
}

export function countdownParts(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  return [
    { label: "DAYS", value: Math.floor(totalSeconds / 86_400) },
    { label: "HOURS", value: Math.floor((totalSeconds % 86_400) / 3_600) },
    { label: "MIN", value: Math.floor((totalSeconds % 3_600) / 60) },
    { label: "SEC", value: totalSeconds % 60 },
  ]
}

export function availableWindows(activated: boolean): IronwoodWindow[] {
  if (!activated) return ["10M", "30M", "1H", "ALL"]
  return ["10M", "30M", "1H", "6H", "24H", "7D", "ALL"]
}

export function txsForWindow(
  transactions: IronwoodMigrationTx[],
  window: IronwoodWindow,
  now: number
): IronwoodMigrationTx[] {
  if (window === "ALL") return transactions
  const cutoff = now - WINDOW_MS[window]
  return transactions.filter(
    (tx) => tx.timestamp != null && tx.timestamp * 1000 >= cutoff
  )
}

export function hasCompleteWindowCoverage(
  transactions: IronwoodMigrationTx[],
  window: IronwoodWindow,
  now: number
): boolean {
  if (window === "ALL") return transactions.length < 500
  if (transactions.length < 500) return true
  const timestamps = transactions
    .map((tx) => tx.timestamp)
    .filter((value): value is number => value != null)
  if (!timestamps.length) return false
  return Math.min(...timestamps) * 1000 <= now - WINDOW_MS[window]
}

export interface MigrationBlockGroup {
  height: number
  timestamp: number | null
  count: number
  volumeZec: number
  transactions: IronwoodMigrationTx[]
}

export function groupMigrationBlocks(
  transactions: IronwoodMigrationTx[]
): MigrationBlockGroup[] {
  const groups = new Map<number, IronwoodMigrationTx[]>()
  for (const tx of transactions) {
    const rows = groups.get(tx.height) ?? []
    rows.push(tx)
    groups.set(tx.height, rows)
  }
  return [...groups.entries()]
    .map(([height, rows]) => ({
      height,
      timestamp:
        rows.find((row) => row.timestamp != null)?.timestamp ?? null,
      count: rows.length,
      volumeZec: rows.reduce((sum, row) => sum + row.amountZec, 0),
      transactions: rows,
    }))
    .sort((a, b) => b.height - a.height)
}

export function latestBlock(
  blocks: IronwoodBlock[]
): IronwoodBlock | undefined {
  return blocks.reduce<IronwoodBlock | undefined>(
    (latest, block) =>
      !latest || block.height > latest.height ? block : latest,
    undefined
  )
}
