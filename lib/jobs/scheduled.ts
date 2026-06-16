import { runUnshieldingWorker } from "../unshieldings/worker"
import {
  parseProgress,
  progressKey,
  type KVLike,
  type PoolMode,
} from "../unshieldings/shared"

type SchedulerEnv = {
  SUPPLY_CACHE?: KVLike
}

type ScheduledJobResult = {
  ok: boolean
  skipped?: boolean
  reason?: string
  details?: Record<string, unknown>
}

type ScheduledJob = {
  name: string
  lockTtlSeconds: number
  shouldRun: (date: Date) => boolean
  run: (kv: KVLike) => Promise<ScheduledJobResult>
}

const JOB_PREFIX = "jobs.scheduler.v1"

function lockKey(name: string) {
  return `${JOB_PREFIX}.${name}.lock`
}

function stateKey(name: string) {
  return `${JOB_PREFIX}.${name}.state`
}

async function acquireLock(
  kv: KVLike,
  name: string,
  ttlSeconds: number
): Promise<string | null> {
  const key = lockKey(name)
  const existing = await kv.get(key).catch(() => null)
  if (existing) return null

  const token = `${Date.now()}:${crypto.randomUUID()}`
  await kv.put(key, token, { expirationTtl: ttlSeconds })
  return token
}

async function releaseLock(kv: KVLike, name: string, token: string) {
  const key = lockKey(name)
  const current = await kv.get(key).catch(() => null)
  if (current !== token) return
  // Workers KV has no delete method in our narrow KVLike. Expire quickly.
  await kv.put(key, "", { expirationTtl: 1 }).catch(() => {})
}

async function writeState(
  kv: KVLike,
  name: string,
  result: ScheduledJobResult,
  startedAt: number,
  finishedAt: number
) {
  await kv
    .put(
      stateKey(name),
      JSON.stringify({
        name,
        ok: result.ok,
        skipped: result.skipped ?? false,
        reason: result.reason ?? null,
        details: result.details ?? null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      })
    )
    .catch(() => {})
}

function unshieldingJob(
  pool: Exclude<PoolMode, "all">,
  shouldRun: (date: Date) => boolean
): ScheduledJob {
  return {
    name: `unshieldings.${pool}`,
    lockTtlSeconds: 180,
    shouldRun,
    async run(kv) {
      await runUnshieldingWorker(pool, kv, {
        inventoryPageBudget: 10,
        prioritize: {
          period: "all",
          sort: "recent",
          limit: 24,
          cursor: null,
        },
      })
      const progress = await kv
        .get(progressKey(pool))
        .then(parseProgress)
        .catch(() => null)
      return {
        ok: true,
        details: {
          pool,
          period: "all",
          sort: "recent",
          total: progress?.total ?? null,
          classified: progress?.classified ?? null,
          complete: progress?.complete ?? null,
        },
      }
    },
  }
}

const JOBS: ScheduledJob[] = [
  // Avoid warming `all` directly: it is Orchard + Sapling and duplicates the
  // same trace lookups. Give Orchard the high-frequency slot, and use one
  // minute out of five for Sapling so the two jobs do not compete.
  unshieldingJob("orchard", (date) => date.getUTCMinutes() % 5 !== 0),
  unshieldingJob("sapling", (date) => date.getUTCMinutes() % 5 === 0),
]

export const SCHEDULED_JOB_NAMES = JOBS.map((job) => job.name)
export const SCHEDULED_JOB_STATE_PREFIX = JOB_PREFIX

export async function runScheduledJobs(
  env: SchedulerEnv,
  cron = "* * * * *",
  now = new Date()
): Promise<ScheduledJobResult[]> {
  const kv = env.SUPPLY_CACHE
  if (!kv) {
    return [{ ok: false, skipped: true, reason: "SUPPLY_CACHE binding missing" }]
  }

  const results: ScheduledJobResult[] = []
  for (const job of JOBS) {
    if (!job.shouldRun(now)) {
      results.push({ ok: true, skipped: true, reason: "not scheduled now" })
      continue
    }

    const startedAt = Date.now()
    const token = await acquireLock(kv, job.name, job.lockTtlSeconds)
    if (!token) {
      const result = { ok: true, skipped: true, reason: "locked" }
      results.push(result)
      continue
    }

    let result: ScheduledJobResult
    try {
      result = await job.run(kv)
    } catch (err) {
      result = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    } finally {
      await releaseLock(kv, job.name, token)
    }

    const finishedAt = Date.now()
    await writeState(
      kv,
      job.name,
      { ...result, details: { ...result.details, cron } },
      startedAt,
      finishedAt
    )
    results.push(result)
  }
  return results
}
