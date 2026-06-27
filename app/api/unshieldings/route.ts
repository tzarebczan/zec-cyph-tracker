import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  UnshieldingPeriod,
  UnshieldingSort,
  UnshieldingsResponse,
} from "@/components/api-types"
import { runUnshieldingWorker } from "@/lib/unshieldings/worker"
import {
  ACTIVATION_BLOCK,
  ACTIVATION_TIME,
  FORCE_REFRESH_HEADERS,
  type KVLike,
  RESPONSE_HEADERS,
  RESPONSE_REFRESH_AFTER_MS,
  WARMING_RESPONSE_HEADERS,
  parseCursor,
  parseLimit,
  parsePeriod,
  parsePool,
  parseProgress,
  parseSort,
  periodCutoff,
  progressKey,
  responseCacheKey,
  staleResponseCacheKey,
} from "@/lib/unshieldings/shared"

function isResponse(payload: UnshieldingsResponse | null): payload is UnshieldingsResponse {
  return (
    payload?.postUnshield?.summary != null &&
    payload.pagination != null &&
    payload.analysis != null
  )
}

function parseCachedPayload(cached: string | null): UnshieldingsResponse | null {
  if (!cached) return null
  try {
    const parsed = JSON.parse(cached) as UnshieldingsResponse
    return isResponse(parsed) ? parsed : null
  } catch {
    return null
  }
}

function responseNeedsWarm(payload: UnshieldingsResponse): boolean {
  return Date.now() - payload.fetchedAt >= RESPONSE_REFRESH_AFTER_MS
}

function responseHeaders(payload: UnshieldingsResponse) {
  return payload.analysis.complete ? RESPONSE_HEADERS : WARMING_RESPONSE_HEADERS
}

function usesActivationProgress(period: UnshieldingPeriod): boolean {
  return periodCutoff(period) <= Date.parse(ACTIVATION_TIME)
}

function overlayProgress(
  payload: UnshieldingsResponse,
  progress: { total: number; classified: number; complete: boolean } | null
): UnshieldingsResponse {
  if (!progress || !usesActivationProgress(payload.period)) return payload
  const total = Math.max(payload.analysis.total, progress.total)
  const analyzed = Math.min(
    total,
    Math.max(payload.analysis.analyzed, progress.classified)
  )
  if (total === payload.analysis.total && analyzed === payload.analysis.analyzed) {
    return payload
  }
  const complete = Boolean(progress.complete && analyzed >= total && total > 0)
  return {
    ...payload,
    totals: {
      ...payload.totals,
      outTx: Math.max(payload.totals.outTx, total),
    },
    analysis: {
      ...payload.analysis,
      total,
      analyzed,
      remaining: Math.max(0, total - analyzed),
      complete,
      warming: !complete,
      cacheHits: Math.max(payload.analysis.cacheHits, analyzed),
    },
    notes: payload.notes.map((note) =>
      note.startsWith("Outcome cache covers ")
        ? `Outcome cache covers ${analyzed} of ${total} transactions and is warming in the background.`
        : note
    ),
  }
}

function emptyWarmingResponse(
  pool: UnshieldingsResponse["pool"],
  period: UnshieldingPeriod,
  sort: UnshieldingSort,
  limit: number,
  progress?: { total: number; classified: number; complete: boolean } | null
): UnshieldingsResponse {
  const cutoffMs = periodCutoff(period)
  const analyzed = Math.max(0, progress?.classified ?? 0)
  const total = Math.max(analyzed, progress?.total ?? 0)
  const complete = Boolean(progress?.complete && total > 0 && analyzed >= total)
  return {
    activation: {
      label: "NU6.2",
      block: ACTIVATION_BLOCK,
      time: ACTIVATION_TIME,
    },
    pool,
    period,
    sort,
    cutoffTime: new Date(cutoffMs).toISOString(),
    fetchedAt: Date.now(),
    totals: {
      outZec: 0,
      outUsd: null,
      outTx: 0,
    },
    postUnshield: {
      summary: {
        traced: 0,
        held: 0,
        spent: 0,
        reshielded: 0,
        reshieldedFull: 0,
        reshieldedPartial: 0,
        reused: 0,
        unknown: 0,
        priorShieldSource: 0,
        tracedZec: 0,
        heldZec: 0,
        spentZec: 0,
        reshieldedZec: 0,
        reusedZec: 0,
      },
      traces: [],
    },
    analysis: {
      total,
      analyzed,
      remaining: Math.max(0, total - analyzed),
      complete,
      warming: true,
      cacheHits: analyzed,
      inventoryComplete: complete,
      refreshing: 0,
    },
    pagination: {
      limit,
      total: 0,
      returned: 0,
      hasNext: false,
      nextCursor: null,
      nextCursorId: null,
      reachedPeriodEnd: false,
    },
    source: {
      flows: "https://api.mainnet.cipherscan.app/api/pools/flows",
      list: "https://api.mainnet.cipherscan.app/api/shielded/list",
    },
    notes: [
      "Warming the deshield outcome cache in the background.",
      "RESHIELD means the same transparent address later moved value into a shielded-touching tx.",
      "SPENT excludes detected reshields and does not prove exchange sale.",
    ],
  }
}

async function getRuntime(): Promise<{
  kv: KVLike | null
  waitUntil: ((promise: Promise<unknown>) => void) | null
}> {
  try {
    const cf = await getCloudflareContext({ async: true })
    return {
      kv:
        (cf?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null,
      waitUntil:
        typeof cf?.ctx?.waitUntil === "function"
          ? cf.ctx.waitUntil.bind(cf.ctx)
          : null,
    }
  } catch {
    return { kv: null, waitUntil: null }
  }
}

async function readProgress(
  kv: KVLike | null,
  pool: UnshieldingsResponse["pool"]
) {
  if (!kv) return null
  try {
    return parseProgress(await kv.get(progressKey(pool)))
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const pool = parsePool(request)
  const period = parsePeriod(request)
  const sort = parseSort(request)
  const limit = parseLimit(request)
  const { cursor } = parseCursor(request)
  const refresh = new URL(request.url).searchParams.has("refresh")
  const runtime = await getRuntime()
  const kv = runtime.kv

  const exactKey = responseCacheKey(pool, period, sort, limit, cursor)

  let payload: UnshieldingsResponse | null = null
  let fromCache = false

  if (kv) {
    try {
      const cached = parseCachedPayload(await kv.get(exactKey))
      if (cached) {
        payload = cached
        fromCache = true
      } else {
        const stale = parseCachedPayload(
          await kv.get(staleResponseCacheKey(exactKey))
        )
        if (stale) {
          payload = { ...stale, stale: true }
          fromCache = true
        }
      }
    } catch {}
  }

  // Progress is only overlaid for the activation-wide ("all") window, where
  // the cron's classification count can advance faster than the cached
  // response. It's a single KV read and only updates the displayed counts.
  const progress = usesActivationProgress(period)
    ? await readProgress(kv, pool)
    : null

  // Demand-driven SWR: serve the cached response and rebuild in the background
  // when it's stale. The cron only classifies (it can't build all presets per
  // tick without exceeding the wall-time limit), so the HTTP path owns preset
  // freshness. Rebuilds are cheap — one blob read + two writes, no per-trace
  // reads — which is the whole point of the trace blob.
  const needsBackgroundWork =
    !fromCache ||
    refresh ||
    (payload ? responseNeedsWarm(payload) : false)

  if (needsBackgroundWork && runtime.waitUntil && kv) {
    runtime.waitUntil(
      runUnshieldingWorker(
        pool,
        kv,
        {
          classify: false,
          buildResponses: true,
          buildAllPresets: false,
          prioritize: { period, sort, limit, cursor },
        }
      ).catch(() => null)
    )
  }

  if (!payload) {
    const warming = emptyWarmingResponse(pool, period, sort, limit, progress)
    return NextResponse.json(warming, { headers: WARMING_RESPONSE_HEADERS })
  }

  // USD values are embedded at build time by the cron; no live price read or
  // repricing on the hot path (price moves negligibly over the 60–90s cache TTL).
  const overlaid = overlayProgress(payload, progress)
  const headers = refresh ? FORCE_REFRESH_HEADERS : responseHeaders(overlaid)
  return NextResponse.json(overlaid, { headers })
}
