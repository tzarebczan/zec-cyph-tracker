import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  SCHEDULED_JOB_NAMES,
  SCHEDULED_JOB_STATE_PREFIX,
} from "@/lib/jobs/scheduled"
import { readStorageHealth, type ShardedPool } from "@/lib/unshieldings/kv-store"

const STORAGE_POOLS: ShardedPool[] = ["ironwood", "orchard", "sapling"]
/** Inventory is saved on every run that refreshes it (at least every 30 min
 *  for the slowest pool), so an older save means the scheduler is stalled. */
const INVENTORY_STALL_MS = 2 * 60 * 60_000
/** Warn well before the 20 MiB put guard, let alone KV's 25 MiB cap. Shards
 *  re-split at 8 MiB, so reaching this means re-sharding is not happening. */
const SHARD_WARN_BYTES = 12 * 1024 * 1024

interface KVLike {
  get(k: string): Promise<string | null>
}

async function getKV(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    return (
      (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
    )
  } catch {
    return null
  }
}

function stateKey(name: string) {
  return `${SCHEDULED_JOB_STATE_PREFIX}.${name}.state`
}

export async function GET() {
  const kv = await getKV()
  if (!kv) {
    return NextResponse.json(
      { ok: false, error: "SUPPLY_CACHE binding missing", jobs: [] },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    )
  }

  const jobs = await Promise.all(
    SCHEDULED_JOB_NAMES.map(async (name) => {
      const raw = await kv.get(stateKey(name)).catch(() => null)
      if (!raw) return { name, state: null }
      try {
        return { name, state: JSON.parse(raw) as unknown }
      } catch {
        return { name, state: null }
      }
    })
  )

  // Storage health per pool, from the shard manifests: when each store was
  // last saved successfully and how big its largest shard is, so a stalled
  // save or a store growing toward the KV value cap is visible here.
  const now = Date.now()
  const warnings: string[] = []
  const storage = Object.fromEntries(
    await Promise.all(
      STORAGE_POOLS.map(async (pool) => {
        try {
          const health = await readStorageHealth(kv, pool)
          for (const [kind, h] of Object.entries(health)) {
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
          return [pool, health] as const
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`${pool}: storage health unreadable (${message})`)
          return [pool, { error: message }] as const
        }
      })
    )
  )

  return NextResponse.json(
    { ok: true, fetchedAt: now, jobs, storage, warnings },
    { headers: { "Cache-Control": "no-store" } }
  )
}
