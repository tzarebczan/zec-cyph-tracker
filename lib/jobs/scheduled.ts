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
): Promise<{ token: string; acquiredAt: number } | null> {
  const key = lockKey(name)
  const existing = await kv.get(key).catch(() => null)
  if (existing) return null

  // The TTL starts at the put, so that is the instant `releaseLock` measures
  // from — not the start of the tick, which would include this read and make
  // the guard fire early and strand the lock until it expires.
  const acquiredAt = Date.now()
  const token = `${acquiredAt}:${crypto.randomUUID()}`
  await kv.put(key, token, { expirationTtl: ttlSeconds })
  return { token, acquiredAt }
}

/** Release a lock this run still owns.
 *
 *  This used to `put(key, "", { expirationTtl: 1 })`. Workers KV's TTL floor is
 *  60, so that write was rejected on every release and the `.catch` next to it
 *  swallowed the rejection: the lock was never released, it only aged out of
 *  its own 90s TTL. With the cron firing every minute, that cost every other
 *  tick — /api/scheduler showed ironwood starting at :28 and :30, never :29.
 *
 *  KV has no compare-and-delete, so this cannot be made atomic; the goal is
 *  only that it never deletes a *successor's* lock. Two checks, neither
 *  sufficient alone:
 *
 *  - The elapsed check. A successor can only exist once our TTL has run out,
 *    so refusing to touch the key at that point is what rules the bad case
 *    out. It matters because KV reads are eventually consistent and can hand
 *    us back our own long-expired token, which the compare below would happily
 *    accept.
 *  - The token compare, for the ordinary case of a successor we can see.
 *
 *  The margin is what makes the first check sound rather than merely likely.
 *  Checking against the bare TTL leaves the window Codex flagged on #93: the
 *  check passes at 89.99s and the delete lands after expiry, by which time
 *  someone else may own the key. Stopping a margin early means a successor
 *  cannot appear for at least that long after the check, which no pair of KV
 *  round-trips will outrun.
 *
 *  Failing to release is the safe direction — the lock expires on its own and
 *  costs at most a skipped tick, which is what a lock is for. Deleting someone
 *  else's is not: it drops the mutual exclusion the job actually relies on. */
const RELEASE_SAFETY_MARGIN_MS = 5_000

async function releaseLock(
  kv: KVLike,
  name: string,
  token: string,
  acquiredAt: number,
  ttlSeconds: number
) {
  const ownUntil = ttlSeconds * 1000 - RELEASE_SAFETY_MARGIN_MS
  if (Date.now() - acquiredAt >= ownUntil) return
  const key = lockKey(name)
  const current = await kv.get(key).catch(() => null)
  if (current !== token) return
  await kv.delete(key).catch(() => {})
}

/** Deliberately unthrottled.
 *
 *  An earlier pass wrote this at most once per ten minutes for successful
 *  runs. It worked, in the end, but it took a recovery bypass, a
 *  persist-then-record ordering, and a KV read to decide all of it from the
 *  shared record instead of isolate memory — because the state entry is read
 *  by /api/scheduler across whichever isolate serves it, and a throttle that
 *  is wrong leaves a recovered job looking broken.
 *
 *  All that bought about 39k writes a month. The three jobs are mutually
 *  exclusive by minute (see JOBS below), so exactly one runs per tick: this is
 *  ~43k writes a month in total, not the ~130k an earlier commit message
 *  claimed by assuming all three ran. Four percent of the monthly budget is
 *  not worth machinery that can misreport the scheduler's health, and the
 *  cron's real costs sit elsewhere — the lock pair is ~86k, and the
 *  every-minute cadence itself governs all of it. */
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
    const lock = await acquireLock(kv, job.name, job.lockTtlSeconds)
    if (!lock) {
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
      await releaseLock(
        kv,
        job.name,
        lock.token,
        lock.acquiredAt,
        job.lockTtlSeconds
      )
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
