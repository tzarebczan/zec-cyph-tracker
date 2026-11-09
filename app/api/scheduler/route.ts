import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  SCHEDULED_JOB_NAMES,
  SCHEDULED_JOB_STATE_PREFIX,
} from "@/lib/jobs/scheduled"
import {
  HEALTH_POOLS,
  poolWarnings,
  readPoolHealth,
} from "@/lib/unshieldings/health"

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

  // Per pool: storage health from the shard manifests (last successful
  // save, largest shard) and classification progress (recent-window
  // pending/failed, backlog growth), with warnings for anything stalled.
  const now = Date.now()
  const pools = await Promise.all(
    HEALTH_POOLS.map(async (pool) => [pool, await readPoolHealth(kv, pool)] as const)
  )
  const storage = Object.fromEntries(pools.map(([pool, h]) => [pool, h.storage]))
  const classification = Object.fromEntries(
    pools.map(([pool, h]) => [pool, h.progress])
  )
  const warnings = pools.flatMap(([pool, h]) => poolWarnings(pool, h, now))

  return NextResponse.json(
    { ok: true, fetchedAt: now, jobs, storage, classification, warnings },
    { headers: { "Cache-Control": "no-store" } }
  )
}
