// Health checks behind /api/scheduler's `warnings`. Pure, so the kv-check
// script can exercise them.

import { readStorageHealth, type ShardedPool, type StoreHealth } from "./kv-store"
import { parseProgress, progressKey, type ClassificationProgress } from "./shared"

export const HEALTH_POOLS: ShardedPool[] = ["ironwood", "orchard", "sapling"]

/** Inventory is saved on every run that refreshes it (at least every 30 min
 *  for the slowest pool), so an older save means the scheduler is stalled. */
export const INVENTORY_STALL_MS = 2 * 60 * 60_000
/** Warn well before the 20 MiB put guard, let alone KV's 25 MiB cap. Shards
 *  re-split at 8 MiB, so reaching this means re-sharding is not happening. */
export const SHARD_WARN_BYTES = 12 * 1024 * 1024
/** New flows are classified newest-first within about one run (10-30 min).
 *  A never-attempted recent flow older than this means that has stopped. */
export const RECENT_PENDING_WARN_MS = 60 * 60_000
/** An incomplete backlog whose classified count has not grown this long is
 *  stalled (each run should add some, or show failures). */
export const BACKLOG_STALL_MS = 2 * 60 * 60_000

export type PoolHealth = {
  storage: Record<"traces" | "inventory", StoreHealth> | { error: string }
  progress: ClassificationProgress | null
}

export function poolWarnings(
  pool: ShardedPool,
  health: PoolHealth,
  now: number
): string[] {
  const warnings: string[] = []
  if ("error" in health.storage) {
    warnings.push(`${pool}: storage health unreadable (${health.storage.error})`)
  } else {
    for (const [kind, h] of Object.entries(health.storage)) {
      if (!h.migrated) {
        warnings.push(`${pool} ${kind}: not migrated to shards yet`)
        continue
      }
      if (h.largestShardBytes > SHARD_WARN_BYTES) {
        warnings.push(`${pool} ${kind}: largest shard ${h.largestShardBytes} bytes`)
      }
      if (kind === "inventory" && now - h.savedAt > INVENTORY_STALL_MS) {
        warnings.push(`${pool} inventory: last saved ${new Date(h.savedAt).toISOString()}`)
      }
    }
  }

  const p = health.progress
  if (p) {
    const recent = p.recent
    if (
      recent?.oldestPendingAt != null &&
      now - recent.oldestPendingAt > RECENT_PENDING_WARN_MS
    ) {
      warnings.push(
        `${pool}: ${recent.pending} recent flows not yet classified, oldest from ${new Date(
          recent.oldestPendingAt
        ).toISOString()}`
      )
    }
    if (
      !p.complete &&
      p.classified < p.total &&
      now - (p.lastGrowthAt ?? p.lastRunAt) > BACKLOG_STALL_MS
    ) {
      warnings.push(
        `${pool}: backlog not moving (${p.classified}/${p.total}) since ${new Date(
          p.lastGrowthAt ?? p.lastRunAt
        ).toISOString()}`
      )
    }
  }
  return warnings
}

export async function readPoolHealth(
  kv: { get(k: string): Promise<string | null> },
  pool: ShardedPool
): Promise<PoolHealth> {
  const [storage, progress] = await Promise.all([
    readStorageHealth(kv, pool).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    })),
    kv.get(progressKey(pool)).then(parseProgress).catch(() => null),
  ])
  return { storage, progress }
}
