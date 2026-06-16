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
  DEFAULT_LIMIT,
  FORCE_REFRESH_HEADERS,
  type KVLike,
  RESPONSE_HEADERS,
  WARMING_RESPONSE_HEADERS,
  fetchLiveZecPrice,
  parseCursor,
  parseLimit,
  parsePeriod,
  parsePool,
  parseProgress,
  parseSort,
  periodCutoff,
  progressKey,
  repricePayload,
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
  if (Date.now() - payload.fetchedAt < 15_000) return false
  return !payload.analysis.complete
}

function responseHeaders(payload: UnshieldingsResponse) {
  return payload.analysis.complete ? RESPONSE_HEADERS : WARMING_RESPONSE_HEADERS
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

  const priceUsd = await fetchLiveZecPrice(kv, runtime.waitUntil, refresh)

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

  const needsBackgroundWork =
    !fromCache || refresh || (payload ? responseNeedsWarm(payload) : false)

  if (needsBackgroundWork && runtime.waitUntil && kv) {
    runtime.waitUntil(
      runUnshieldingWorker(pool, kv, {
        force: refresh,
        prioritize: { period, sort, limit, cursor },
      }).catch(() => null)
    )
  }

  if (!payload) {
    const progress = period === "all" ? await readProgress(kv, pool) : null
    const warming = emptyWarmingResponse(pool, period, sort, limit, progress)
    return NextResponse.json(warming, { headers: WARMING_RESPONSE_HEADERS })
  }

  const repriced = repricePayload(payload, priceUsd)
  const headers = refresh ? FORCE_REFRESH_HEADERS : responseHeaders(repriced)
  return NextResponse.json(repriced, { headers })
}
