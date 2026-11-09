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
  run: (kv: KVLike, now: Date) => Promise<ScheduledJobResult>
}

const JOB_PREFIX = "jobs.scheduler.v1"

/** Longest gap between one pool's runs is 30 min (orchard, sapling); keep
 *  presets alive past that with margin for a skipped or slow run. */
const SCHEDULED_RESPONSE_TTL_SECONDS = 75 * 60

/** Classified before the backlog on every run, newest first. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000
/** CipherScan requests per run for classification. Equal to the limiter's
 *  bucket (75 per minute), so a run never blocks on it: classification
 *  finishes in ~10 s at 8-way concurrency and the run stays far inside the
 *  90 s lock TTL even with preset rebuilds (~20-30 s observed). */
const CLASSIFY_REQUEST_BUDGET = 75

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
    // A run (classification within one limiter bucket plus preset rebuilds)
    // takes ~20-40s; the lock just prevents overlap. Keep the TTL short so a
    // killed run recovers by the next tick.
    lockTtlSeconds: 90,
    shouldRun,
    async run(kv, now) {
      // The scheduler is the only writer of inventory, traces and the warm
      // response presets. Requests read the presets from cache and never
      // rebuild them (app/api/unshieldings/route.ts), so the ~50 MB of
      // inventory + traces is parsed here, a few times an hour, instead of
      // on every request-driven SWR refresh. Response TTLs outlast the
      // longest gap between this pool's runs so presets never expire between
      // them. (The old reason for keeping presets out of the cron, per-trace
      // KV reads blowing the wall-time limit, went away with the trace blob;
      // cron invocations get 15 minutes.)
      await runUnshieldingWorker(pool, kv, {
        buildResponses: true,
        buildAllPresets: true,
        responseTtlSeconds: SCHEDULED_RESPONSE_TTL_SECONDS,
        recheckCachedTraces: false,
        refreshHead: true,
        classifyPartialInventory: true,
        // Newest week first, then the backlog. Each run may make up to
        // CLASSIFY_REQUEST_BUDGET CipherScan requests, which is one full
        // limiter bucket, so it never waits on the limiter. That works out to
        // ~37 flows at worst (2 requests each) and ~50-60 typically. Runs are
        // 10-30 min apart now, so this is well below the old per-minute
        // cadence's sustained request rate.
        recentWindowMs: RECENT_WINDOW_MS,
        requestBudget: CLASSIFY_REQUEST_BUDGET,
        classificationBatchSize: 75,
        inventoryPageBudget:
          pool === "ironwood" ? 3 : pool === "orchard" ? 5 : 10,
      })
      // The merged `all` view has no store of its own. Rebuild its presets
      // read-only over the three pools (~120 MB of parsing), twice an hour on
      // the ironwood job; the TTL covers the gap.
      if (pool === "ironwood" && now.getUTCMinutes() % 30 === 0) {
        await runUnshieldingWorker("all", kv, {
          classify: false,
          refreshInventory: false,
          buildResponses: true,
          buildAllPresets: true,
          responseTtlSeconds: SCHEDULED_RESPONSE_TTL_SECONDS,
        })
      }
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
  // These predicates assume the cron in wrangler.jsonc fires on minutes that
  // hit every pool (currently 0,2,7,10,20,30,32,37,40,50). A uniform "*/5" or
  // "*/10" would only ever select ironwood.
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
      result = await job.run(kv, now)
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
