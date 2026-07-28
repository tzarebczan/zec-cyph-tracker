import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const CIPHERSCAN_MIGRATION_PAGE = "https://cipherscan.app/migration"
const IRONWOOD_ACTIVATION_HEIGHT = 3_428_143
const NU62_ACTIVATION_HEIGHT = 3_364_600
// "Final approach" window for the at-a-glance progress bar. `phaseProgressPct`
// spans the whole 63k-block gap since NU6.2, so it reads ~99% for the last
// several days and is useless as a visual. The last 1,000 blocks (~21h) is the
// stretch where a progress bar actually moves.
const APPROACH_WINDOW_BLOCKS = 1_000
const CACHE_KEY = "zec.ironwood.v2"
const STALE_KEY = "zec.ironwood.stale.v2"
const BLOCK_TIME_KEY = "zec.ironwood.block-time.v1"
const CACHE_TTL_SECONDS = 60
const BLOCK_TIME_TTL_SECONDS = 6 * 60 * 60
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>
}

interface MigrationOverview {
  success?: boolean
  activationHeight?: number
  tipHeight?: number
  activated?: boolean
  avgBlockTimeSecs?: number
  blocksUntilActivation?: number
  poolSizes?: {
    orchardZat?: number
    ironwoodZat?: number
    updatedAt?: string
  }
  migration?: {
    totalMigratedZat?: number
    txCount?: number
    firstHeight?: number | null
    lastHeight?: number | null
    migratedPercent?: number
  }
  supplyAudit?: {
    orchardOutZat?: number
    ironwoodInZat?: number
    balanced?: boolean
  }
}

interface NetworkStats {
  success?: boolean
  mining?: { avgBlockTime?: number }
  network?: { height?: number }
  timestamp?: number
}

export interface IronwoodResponse {
  activationHeight: number
  currentHeight: number
  blocksRemaining: number
  activated: boolean
  avgBlockTimeSecs: number
  blockTimeSource: "cipherscan" | "protocol-target"
  estimatedActivationAt: number | null
  activationProgressPct: number
  phaseProgressPct: number
  /** Progress through the final 1,000 blocks before the gate. */
  approachProgressPct: number
  migration: {
    totalMigratedZec: number
    txCount: number
    migratedPercent: number
    orchardZec: number
    ironwoodZec: number
    balanced: boolean | null
    firstHeight: number | null
    lastHeight: number | null
  } | null
  source: string
  fetchedAt: number
  stale?: boolean
}

async function getRuntime(): Promise<{
  kv: KVLike | null
  waitUntil: ((promise: Promise<unknown>) => void) | null
}> {
  try {
    const context = await getCloudflareContext({ async: true })
    return {
      kv:
        (context?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ??
        null,
      waitUntil:
        typeof context?.ctx?.waitUntil === "function"
          ? context.ctx.waitUntil.bind(context.ctx)
          : null,
    }
  } catch {
    return { kv: null, waitUntil: null }
  }
}

async function readCache(
  kv: KVLike | null,
  key: string
): Promise<IronwoodResponse | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as IronwoodResponse
    if (!Number.isFinite(parsed.currentHeight) || !parsed.activationHeight) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(kv: KVLike | null, payload: IronwoodResponse) {
  if (!kv) return
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS }),
    kv.put(STALE_KEY, json),
  ]).catch(() => {})
}

async function readBlockTime(kv: KVLike | null): Promise<number | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(BLOCK_TIME_KEY)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

async function refreshBlockTime(kv: KVLike | null): Promise<number | null> {
  try {
    const stats = await fetchJson<NetworkStats>("/network/stats")
    const seconds = stats?.mining?.avgBlockTime
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
    await kv
      ?.put(BLOCK_TIME_KEY, String(seconds), {
        expirationTtl: BLOCK_TIME_TTL_SECONDS,
      })
      .catch(() => {})
    return seconds
  } catch (error) {
    console.warn("[ironwood] block-time refresh failed", error)
    return null
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const response = await fetch(`${CIPHERSCAN}${path}`, {
    headers: {
      Accept: "application/json",
      Origin: "https://cipherscan.app",
      Referer: CIPHERSCAN_MIGRATION_PAGE,
    },
    next: { revalidate: CACHE_TTL_SECONDS },
  })
  if (!response.ok) throw new Error(`CipherScan ${path} failed: ${response.status}`)
  return response.json() as Promise<T>
}

function zecFromZat(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? value / 100_000_000 : 0
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export async function GET() {
  const { kv, waitUntil } = await getRuntime()
  const cached = await readCache(kv, CACHE_KEY)
  if (cached) return NextResponse.json(cached, { headers: RESPONSE_HEADERS })

  try {
    // `/migration/overview` is authoritative both before and after the gate:
    // pre-activation it still returns the live tip, the observed block
    // interval, and blocksUntilActivation. It previously only ran once the
    // tip had passed the activation height, which meant the countdown — the
    // one thing that matters pre-activation — was driven by a cached or
    // hard-coded 75s block time instead of cipherscan's observed interval.
    const overview = await fetchJson<MigrationOverview>("/migration/overview")
    const activationHeight =
      overview?.activationHeight ?? IRONWOOD_ACTIVATION_HEIGHT
    const currentHeight = overview?.tipHeight ?? 0
    if (currentHeight <= 0) throw new Error("CipherScan returned no chain height")

    const cachedBlockTime = await readBlockTime(kv)
    const overviewBlockTime = overview?.avgBlockTimeSecs
    const avgBlockTimeSecs = Math.max(
      1,
      overviewBlockTime ?? cachedBlockTime ?? 75
    )
    if (overviewBlockTime == null && cachedBlockTime == null && waitUntil) {
      waitUntil(refreshBlockTime(kv))
    }
    const blocksRemaining = Math.max(
      0,
      overview?.blocksUntilActivation ?? activationHeight - currentHeight
    )
    const activated = overview?.activated ?? blocksRemaining === 0
    const estimatedActivationAt = activated
      ? null
      : Date.now() + blocksRemaining * avgBlockTimeSecs * 1000
    const phaseSpan = Math.max(1, activationHeight - NU62_ACTIVATION_HEIGHT)
    const poolSizes = overview?.poolSizes
    const migration = overview?.migration
      ? {
          totalMigratedZec: zecFromZat(overview.migration.totalMigratedZat),
          txCount: overview.migration.txCount ?? 0,
          migratedPercent: overview.migration.migratedPercent ?? 0,
          orchardZec: zecFromZat(poolSizes?.orchardZat),
          ironwoodZec: zecFromZat(poolSizes?.ironwoodZat),
          balanced: overview.supplyAudit?.balanced ?? null,
          firstHeight: overview.migration.firstHeight ?? null,
          lastHeight: overview.migration.lastHeight ?? null,
        }
      : null

    const payload: IronwoodResponse = {
      activationHeight,
      currentHeight,
      blocksRemaining,
      activated,
      avgBlockTimeSecs,
      blockTimeSource:
        overviewBlockTime != null || cachedBlockTime != null
          ? "cipherscan"
          : "protocol-target",
      estimatedActivationAt,
      activationProgressPct: clampPct((currentHeight / activationHeight) * 100),
      phaseProgressPct: clampPct(
        ((currentHeight - NU62_ACTIVATION_HEIGHT) / phaseSpan) * 100
      ),
      approachProgressPct: activated
        ? 100
        : clampPct(
            ((APPROACH_WINDOW_BLOCKS - blocksRemaining) /
              APPROACH_WINDOW_BLOCKS) *
              100
          ),
      migration,
      source: CIPHERSCAN_MIGRATION_PAGE,
      fetchedAt: Date.now(),
    }
    await writeCache(kv, payload)
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (error) {
    console.error("[ironwood] refresh failed", error)
    const stale = await readCache(kv, STALE_KEY)
    if (stale) {
      return NextResponse.json(
        { ...stale, stale: true },
        { headers: RESPONSE_HEADERS }
      )
    }
    return NextResponse.json(
      { error: "Ironwood tracker is temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
