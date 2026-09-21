import { shouldWriteMirror } from "../kv-mirror"
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

/** How often a *successful, unremarkable* run records its state. The state
 *  entry drives /api/scheduler, a debug view — one write per job per minute
 *  (~130k/month) to timestamp "still fine" is not worth it. Failures always
 *  write, so a problem still shows up immediately. */
const STATE_HEARTBEAT_MS = 10 * 60_000

/** Jobs whose last persisted state was a failure, for this isolate. */
const lastPersistedFailed = new Set<string>()

async function writeState(
  kv: KVLike,
  name: string,
  result: ScheduledJobResult,
  startedAt: number,
  finishedAt: number
) {
  // A failure always writes, but it does not touch the throttle — so without
  // this, the first success after a failure gets throttled against the *last
  // success*, and /api/scheduler keeps reporting the failure for up to ten
  // minutes after the job recovered. A recovery is exactly the state change
  // the view exists to show, so it bypasses the heartbeat.
  const recovering = result.ok && lastPersistedFailed.has(name)
  if (result.ok && !recovering && !shouldWriteMirror(stateKey(name), STATE_HEARTBEAT_MS)) {
    return
  }
  if (result.ok) {
    lastPersistedFailed.delete(name)
    // Count the recovery write against the heartbeat, so a job that flaps does
    // not write on every tick.
    if (recovering) shouldWriteMirror(stateKey(name), 0)
  } else {
    lastPersistedFailed.add(name)
  }
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
    // A normal classify-only run takes ~15-20s; the lock just prevents
    // overlap. Keep the TTL short so a run killed by the wall-time limit
    // recovers within a couple of ticks instead of 5 minutes.
    lockTtlSeconds: 90,
    shouldRun,
    async run(kv) {
      // The cron only classifies traces and refreshes inventory + progress.
      // It does NOT build response caches: building all 24 presets per tick
      // plus classification exceeds the scheduled-handler wall-time limit and
      // gets killed mid-run (holding the lock). Per-request preset builds are
      // cheap now that traces live in a single blob (one read + two writes),
      // so the HTTP path owns demand-driven SWR rebuilds instead.
      await runUnshieldingWorker(pool, kv, {
        buildResponses: false,
        recheckCachedTraces: false,
        refreshHead: true,
        classifyPartialInventory: true,
        classificationBatchSize:
          pool === "ironwood" ? 20 : pool === "orchard" ? 40 : 75,
        inventoryPageBudget:
          pool === "ironwood" ? 3 : pool === "orchard" ? 5 : 10,
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
  // Avoid warming `all` directly: it merges the three per-pool inventories.
  // Stagger jobs so only one classifier spends CipherScan's rate budget in a
  // given minute. Ironwood is the active default; legacy pools refresh less
  // often while their aggregate flow charts stay live through the direct API.
  unshieldingJob(
    "ironwood",
    (date) =>
      date.getUTCMinutes() % 5 !== 2 && date.getUTCMinutes() % 15 !== 7
  ),
  unshieldingJob(
    "orchard",
    (date) =>
      date.getUTCMinutes() % 5 === 2 && date.getUTCMinutes() % 15 !== 7
  ),
  unshieldingJob("sapling", (date) => date.getUTCMinutes() % 15 === 7),
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
