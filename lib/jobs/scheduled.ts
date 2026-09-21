import { runUnshieldingWorker } from "../unshieldings/worker"
import {
  parseProgress,
  progressKey,
  type KVLike,
  type PoolMode,
} from "../unshieldings/shared"
import {
  acquireJobLock,
  releaseJobLock,
  type LockNamespaceLike,
} from "./scheduler-lock"

type SchedulerEnv = {
  SUPPLY_CACHE?: KVLike
  SCHEDULER_LOCK?: LockNamespaceLike
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

function stateKey(name: string) {
  return `${JOB_PREFIX}.${name}.state`
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
 *  not worth machinery that can misreport the scheduler's health. The lock
 *  pair used to be the larger cost at ~86k; it is a Durable Object now and no
 *  longer KV writes at all, which leaves this entry and the every-minute
 *  cadence that governs it. */
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

  // Without the lock there is nothing keeping two ticks off the same inventory
  // and progress blob, so a missing binding stops the scheduler rather than
  // running it unprotected. It can only mean a deploy that shipped the code
  // without the binding.
  //
  // Record it against the jobs that were due, for the same reason the
  // `lock-unavailable` branch below does: /api/scheduler reads only these
  // state entries, so a silent return would leave it showing the last
  // successful runs while every job is in fact disabled. Jobs that were not
  // due this minute are left alone — they are not failing, they are not up.
  const locks = env.SCHEDULER_LOCK
  if (!locks) {
    const reason = "SCHEDULER_LOCK binding missing"
    const at = Date.now()
    await Promise.all(
      JOBS.filter((job) => job.shouldRun(now)).map((job) =>
        writeState(
          kv,
          job.name,
          { ok: false, skipped: true, reason, details: { cron } },
          at,
          at
        )
      )
    )
    return [{ ok: false, skipped: true, reason }]
  }

  const results: ScheduledJobResult[] = []
  for (const job of JOBS) {
    if (!job.shouldRun(now)) {
      results.push({ ok: true, skipped: true, reason: "not scheduled now" })
      continue
    }

    const startedAt = Date.now()
    const lock = await acquireJobLock(locks, job.name, job.lockTtlSeconds)
    if (!lock.token) {
      // Contention is the lock doing its job, so it stays `ok`. An unreachable
      // lock object is not, and it also has to be *recorded*: state is only
      // written after a run, so without this /api/scheduler would keep showing
      // the last success and a dead lock would look like a healthy scheduler.
      const result: ScheduledJobResult = {
        ok: lock.reason === "locked",
        skipped: true,
        reason: lock.reason,
      }
      if (!result.ok) {
        await writeState(kv, job.name, { ...result, details: { cron } }, startedAt, Date.now())
      }
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
      await releaseJobLock(locks, job.name, lock.token)
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
