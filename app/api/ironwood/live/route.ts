import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  IRONWOOD_ACTIVATION_HEIGHT,
  type IronwoodAnalytics,
  type IronwoodBlock,
  type IronwoodLiveOverview,
  type IronwoodLiveResponse,
  type IronwoodMempoolTx,
  type IronwoodMigrationTx,
} from "@/lib/ironwood-live"

export const dynamic = "force-dynamic"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const CIPHERSCAN_PAGE = "https://cipherscan.app/ironwood"
const LIVE_KEY = "zec.ironwood.live.v2"
const ANALYTICS_KEY = "zec.ironwood.analytics.v1"
const LIVE_FRESH_MS = 8_000
const ANALYTICS_FRESH_MS = 60_000
const PRE_ACTIVATION_ANALYTICS_FRESH_MS = 5 * 60_000
const UPSTREAM_TIMEOUT_MS = 8_000
const RESPONSE_HEADERS = {
  "Cache-Control":
    "public, max-age=0, s-maxage=8, stale-while-revalidate=30",
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string) => Promise<void>
}

interface CacheEnvelope<T> {
  value: T
  fetchedAt: number
  activated?: boolean
}

interface RawOverview {
  success?: boolean
  activationHeight?: number
  tipHeight?: number
  activated?: boolean
  avgBlockTimeSecs?: number
  blocksUntilActivation?: number
  poolSizes?: {
    orchardZat?: number
    ironwoodZat?: number
    sproutZat?: number
    saplingZat?: number
    transparentZat?: number
    shieldedTotalZat?: number
    chainSupplyZat?: number
    updatedAt?: string
    sourceHeight?: number
    isLive?: boolean
  }
  migration?: {
    totalMigratedZat?: number
    txCount?: number
    firstHeight?: number | null
    lastHeight?: number | null
    migratedPercent?: number
    velocityZatPerHour?: number
  }
  inflowSources?: {
    fromOrchardZat?: number
    fromOrchardTxs?: number
    fromSaplingZat?: number
    fromSaplingTxs?: number
    fromTransparentZat?: number
    fromTransparentTxs?: number
    fromCoinbaseZat?: number
    fromCoinbaseTxs?: number
    totalInZat?: number
    totalOutZat?: number
  }
  supplyAudit?: {
    orchardOutZat?: number
    coinbaseInZat?: number
    ironwoodInZat?: number
    ironwoodOutZat?: number
    indexedNetZat?: number
    authoritativePoolZat?: number
    differenceZat?: number
    accountingHeight?: number
    sourceHeight?: number
    status?: string
    balanced?: boolean | null
  }
  supplyVerification?: {
    chainSupplyZat?: number
    verifiedZat?: number
    unverifiedZat?: number
    verifiedPct?: number
  }
}

interface RawBlocks {
  blocks?: Array<{
    height?: number
    hash?: string
    timestamp?: number
    txCount?: number
    size?: number
    fees?: number
    minerReward?: number
  }>
}

interface RawBlockDetail {
  timestamp?: string | number
  transactions?: Array<{
    txid?: string
    block_height?: string | number
    block_time?: string | number
    version?: string | number
    vin_count?: string | number
    vout_count?: string | number
    value_balance_orchard?: string | number
    value_balance_ironwood?: string | number
    has_orchard?: boolean
    has_ironwood?: boolean
    orchard_actions?: string | number
    ironwood_actions?: string | number
    is_coinbase?: boolean
  }>
}

interface RawMempool {
  count?: number
  transactions?: Array<{
    txid?: string
    size?: number
    time?: number
    type?: string
    vin?: number
    vout?: number
    orchardActions?: number
    ironwoodActions?: number
    hasIronwood?: boolean
    valueBalanceOrchard?: number
    valueBalanceIronwood?: number
  }>
}

interface RawScatter {
  total?: number
  denominatedCount?: number
  distinctiveCount?: number
  denominatedPercent?: number
  denominatedVolumeZat?: number
  distinctiveVolumeZat?: number
  txs?: Array<{
    txid?: string
    height?: number
    timestamp?: number | null
    amountZat?: number
    amountZec?: number
    orchardOutZat?: number
    isCoinbase?: boolean
    privacy?: "denominated" | "distinctive"
    matchedDenomination?: number | null
  }>
}

interface RawCohorts {
  boundaryModulus?: number
  cohortCount?: number
  avgAnonymitySet?: number
  minAnonymitySet?: number
  maxAnonymitySet?: number
  cohorts?: Array<{
    boundary?: number
    boundaryStartHeight?: number
    txCount?: number
    volumeZat?: number
    firstTime?: number | null
    ironwoodPoolZat?: number | null
    orchardOutflowZat?: number | null
  }>
}

interface RawDenominations {
  bins?: Array<{
    power?: number
    denomination?: number
    label?: string
    txCount?: number
    volumeZat?: number
  }>
}

interface LiveSnapshot {
  overview: IronwoodLiveOverview
  blocks: IronwoodBlock[]
  mempool: IronwoodLiveResponse["mempool"]
  recentMigrations: IronwoodMigrationTx[]
}

function zec(value: string | number | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed / 100_000_000 : 0
}

function finite(
  value: string | number | null | undefined,
  fallback = 0
): number {
  if (value == null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function getKv(): Promise<KVLike | null> {
  try {
    const context = await getCloudflareContext({ async: true })
    return (
      (context?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ??
      null
    )
  } catch {
    return null
  }
}

async function readEnvelope<T>(
  kv: KVLike | null,
  key: string
): Promise<CacheEnvelope<T> | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEnvelope<T>
    return Number.isFinite(parsed.fetchedAt) && parsed.value ? parsed : null
  } catch {
    return null
  }
}

async function writeEnvelope<T>(
  kv: KVLike | null,
  key: string,
  envelope: CacheEnvelope<T>
) {
  if (!kv) return
  await kv.put(key, JSON.stringify(envelope)).catch(() => {})
}

async function fetchJson<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(`${CIPHERSCAN}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Origin: "https://cipherscan.app",
        Referer: CIPHERSCAN_PAGE,
      },
    })
    if (!response.ok) {
      throw new Error(`CipherScan ${path} returned ${response.status}`)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeOverview(raw: RawOverview): IronwoodLiveOverview {
  const activationHeight =
    finite(raw.activationHeight, IRONWOOD_ACTIVATION_HEIGHT) ||
    IRONWOOD_ACTIVATION_HEIGHT
  const tipHeight = finite(raw.tipHeight)
  const blocksUntilActivation = Math.max(
    0,
    finite(raw.blocksUntilActivation, activationHeight - tipHeight)
  )
  const activated = raw.activated ?? blocksUntilActivation === 0
  const avgBlockTimeSecs = Math.max(1, finite(raw.avgBlockTimeSecs, 75))
  const pools = raw.poolSizes ?? {}
  const migration = raw.migration ?? {}
  const inflows = raw.inflowSources ?? {}
  const audit = raw.supplyAudit ?? {}
  const verification = raw.supplyVerification

  return {
    activationHeight,
    tipHeight,
    activated,
    avgBlockTimeSecs,
    blocksUntilActivation,
    estimatedActivationAt: activated
      ? null
      : Date.now() + blocksUntilActivation * avgBlockTimeSecs * 1000,
    poolSizes: {
      orchardZec: zec(pools.orchardZat),
      ironwoodZec: zec(pools.ironwoodZat),
      sproutZec: zec(pools.sproutZat),
      saplingZec: zec(pools.saplingZat),
      transparentZec: zec(pools.transparentZat),
      shieldedTotalZec: zec(pools.shieldedTotalZat),
      chainSupplyZec: zec(pools.chainSupplyZat),
      updatedAt: pools.updatedAt ?? null,
      sourceHeight: finite(pools.sourceHeight, tipHeight),
      isLive: pools.isLive ?? false,
    },
    migration: {
      totalMigratedZec: zec(migration.totalMigratedZat),
      txCount: finite(migration.txCount),
      firstHeight: migration.firstHeight ?? null,
      lastHeight: migration.lastHeight ?? null,
      migratedPercent: finite(migration.migratedPercent),
      velocityZecPerHour: zec(migration.velocityZatPerHour),
    },
    inflowSources: {
      fromOrchardZec: zec(inflows.fromOrchardZat),
      fromOrchardTxs: finite(inflows.fromOrchardTxs),
      fromSaplingZec: zec(inflows.fromSaplingZat),
      fromSaplingTxs: finite(inflows.fromSaplingTxs),
      fromTransparentZec: zec(inflows.fromTransparentZat),
      fromTransparentTxs: finite(inflows.fromTransparentTxs),
      fromCoinbaseZec: zec(inflows.fromCoinbaseZat),
      fromCoinbaseTxs: finite(inflows.fromCoinbaseTxs),
      totalInZec: zec(inflows.totalInZat),
      totalOutZec: zec(inflows.totalOutZat),
    },
    supplyAudit: {
      orchardOutZec: zec(audit.orchardOutZat),
      coinbaseInZec: zec(audit.coinbaseInZat),
      ironwoodInZec: zec(audit.ironwoodInZat),
      ironwoodOutZec: zec(audit.ironwoodOutZat),
      indexedNetZec: zec(audit.indexedNetZat),
      authoritativePoolZec: zec(audit.authoritativePoolZat),
      differenceZec: zec(audit.differenceZat),
      accountingHeight: finite(audit.accountingHeight, tipHeight),
      sourceHeight: finite(audit.sourceHeight, tipHeight),
      status: audit.status ?? "stale",
      balanced: audit.balanced ?? null,
    },
    supplyVerification: verification
      ? {
          chainSupplyZec: zec(verification.chainSupplyZat),
          verifiedZec: zec(verification.verifiedZat),
          unverifiedZec: zec(verification.unverifiedZat),
          verifiedPct: finite(verification.verifiedPct),
        }
      : null,
  }
}

function normalizeBlocks(raw: RawBlocks): IronwoodBlock[] {
  return (raw.blocks ?? [])
    .map((block) => ({
      height: finite(block.height),
      hash: block.hash ?? "",
      timestamp: finite(block.timestamp),
      txCount: finite(block.txCount),
      size: finite(block.size),
      feesZec: finite(block.fees),
      minerRewardZec: finite(block.minerReward),
    }))
    .filter((block) => block.height > 0 && block.hash)
}

const COMMON_DENOMINATIONS = [0.001, 0.01, 0.1, 1, 10, 100, 1_000]

function classifyAmount(amountZec: number): {
  privacy: IronwoodMigrationTx["privacy"]
  matchedDenomination: number | null
} {
  const matched =
    COMMON_DENOMINATIONS.find(
      (denomination) =>
        Math.abs(amountZec - denomination) / denomination <= 0.001
    ) ?? null
  return {
    privacy: matched == null ? "distinctive" : "denominated",
    matchedDenomination: matched,
  }
}

function normalizeBlockMigrations(
  raw: RawBlockDetail,
  fallbackHeight: number
): IronwoodMigrationTx[] {
  return (raw.transactions ?? [])
    .filter((tx) => {
      const orchardOut = finite(tx.value_balance_orchard)
      const ironwoodIn = -finite(tx.value_balance_ironwood)
      return (
        finite(tx.version) === 6 &&
        !tx.is_coinbase &&
        finite(tx.vin_count) === 0 &&
        finite(tx.vout_count) === 0 &&
        (tx.has_orchard || finite(tx.orchard_actions) > 0) &&
        (tx.has_ironwood || finite(tx.ironwood_actions) > 0) &&
        orchardOut > 0 &&
        ironwoodIn > 0
      )
    })
    .map((tx) => {
      const amountZec = zec(-finite(tx.value_balance_ironwood))
      return {
        txid: tx.txid ?? "",
        height: finite(tx.block_height, fallbackHeight),
        timestamp: finite(tx.block_time ?? raw.timestamp) || null,
        amountZec,
        orchardOutZec: zec(tx.value_balance_orchard),
        isCoinbase: false,
        ...classifyAmount(amountZec),
      }
    })
    .filter((tx) => /^[a-f0-9]{64}$/i.test(tx.txid) && tx.amountZec > 0)
}

function normalizeMempool(raw: RawMempool): IronwoodLiveResponse["mempool"] {
  const transactions: IronwoodMempoolTx[] = (raw.transactions ?? [])
    .filter((tx) => {
      const orchardOut = finite(tx.valueBalanceOrchard)
      const ironwoodIn = -finite(tx.valueBalanceIronwood)
      return (
        (tx.hasIronwood || finite(tx.ironwoodActions) > 0) &&
        orchardOut > 0 &&
        ironwoodIn > 0
      )
    })
    .map((tx) => ({
      txid: tx.txid ?? "",
      size: finite(tx.size),
      timestamp: finite(tx.time),
      type: tx.type ?? "shielded",
      vin: finite(tx.vin),
      vout: finite(tx.vout),
      orchardActions: finite(tx.orchardActions),
      ironwoodActions: finite(tx.ironwoodActions),
      orchardOutZec: finite(tx.valueBalanceOrchard),
      ironwoodInZec: -finite(tx.valueBalanceIronwood),
    }))
    .filter((tx) => /^[a-f0-9]{64}$/i.test(tx.txid))

  return {
    totalCount: finite(raw.count),
    migrationCount: transactions.length,
    migrationVolumeZec: transactions.reduce(
      (sum, tx) => sum + tx.ironwoodInZec,
      0
    ),
    transactions,
  }
}

async function refreshLive(): Promise<LiveSnapshot> {
  const [overview, mempool, blocks] = await Promise.all([
    fetchJson<RawOverview>("/migration/overview"),
    fetchJson<RawMempool>("/mempool"),
    fetchJson<RawBlocks>("/network/blocks/recent?limit=16"),
  ])
  const normalizedOverview = normalizeOverview(overview)
  const normalizedBlocks = normalizeBlocks(blocks)
  if (
    overview.success === false ||
    normalizedOverview.tipHeight <= 0 ||
    normalizedBlocks.length === 0
  ) {
    throw new Error("CipherScan returned an incomplete Ironwood snapshot")
  }
  let recentMigrations: IronwoodMigrationTx[] = []
  if (normalizedOverview.activated) {
    try {
      const latestBlock = await fetchJson<RawBlockDetail>(
        `/block/${normalizedOverview.tipHeight}`
      )
      recentMigrations = normalizeBlockMigrations(
        latestBlock,
        normalizedOverview.tipHeight
      )
    } catch {
      // The aggregate feed remains available if latest-block enrichment lags.
    }
  }
  return {
    overview: normalizedOverview,
    blocks: normalizedBlocks,
    mempool: normalizeMempool(mempool),
    recentMigrations,
  }
}

function emptyAnalytics(): IronwoodAnalytics {
  return {
    total: 0,
    denominatedCount: 0,
    distinctiveCount: 0,
    denominatedPercent: 0,
    denominatedVolumeZec: 0,
    distinctiveVolumeZec: 0,
    transactions: [],
    cohortCount: 0,
    boundaryModulus: 256,
    avgAnonymitySet: 0,
    minAnonymitySet: 0,
    maxAnonymitySet: 0,
    cohorts: [],
    denominations: [],
  }
}

async function refreshAnalytics(): Promise<IronwoodAnalytics> {
  const [scatter, cohorts, denominations] = await Promise.all([
    fetchJson<RawScatter>("/migration/scatter"),
    fetchJson<RawCohorts>("/migration/cohorts"),
    fetchJson<RawDenominations>("/migration/denominations"),
  ])
  return {
    total: finite(scatter.total),
    denominatedCount: finite(scatter.denominatedCount),
    distinctiveCount: finite(scatter.distinctiveCount),
    denominatedPercent: finite(scatter.denominatedPercent),
    denominatedVolumeZec: zec(scatter.denominatedVolumeZat),
    distinctiveVolumeZec: zec(scatter.distinctiveVolumeZat),
    transactions: (scatter.txs ?? [])
      .map((tx) => ({
        txid: tx.txid ?? "",
        height: finite(tx.height),
        timestamp:
          tx.timestamp != null && Number.isFinite(tx.timestamp)
            ? Number(tx.timestamp)
            : null,
        amountZec: finite(tx.amountZec, zec(tx.amountZat)),
        orchardOutZec: zec(tx.orchardOutZat),
        isCoinbase: tx.isCoinbase ?? false,
        privacy:
          tx.privacy === "denominated"
            ? ("denominated" as const)
            : ("distinctive" as const),
        matchedDenomination: tx.matchedDenomination ?? null,
      }))
      .filter((tx) => /^[a-f0-9]{64}$/i.test(tx.txid) && tx.height > 0),
    cohortCount: finite(cohorts.cohortCount),
    boundaryModulus: finite(cohorts.boundaryModulus, 256),
    avgAnonymitySet: finite(cohorts.avgAnonymitySet),
    minAnonymitySet: finite(cohorts.minAnonymitySet),
    maxAnonymitySet: finite(cohorts.maxAnonymitySet),
    cohorts: (cohorts.cohorts ?? []).map((cohort) => ({
      boundary: finite(cohort.boundary),
      boundaryStartHeight: finite(cohort.boundaryStartHeight),
      txCount: finite(cohort.txCount),
      volumeZec: zec(cohort.volumeZat),
      firstTime:
        cohort.firstTime != null && Number.isFinite(cohort.firstTime)
          ? Number(cohort.firstTime)
          : null,
      ironwoodPoolZec:
        cohort.ironwoodPoolZat == null
          ? null
          : zec(cohort.ironwoodPoolZat),
      orchardOutflowZec:
        cohort.orchardOutflowZat == null
          ? null
          : zec(cohort.orchardOutflowZat),
    })),
    denominations: (denominations.bins ?? []).map((bin) => ({
      power: finite(bin.power),
      denomination: finite(bin.denomination),
      label: bin.label ?? `${finite(bin.denomination)} ZEC`,
      txCount: finite(bin.txCount),
      volumeZec: zec(bin.volumeZat),
    })),
  }
}

function mergeRecentMigrations(
  analytics: IronwoodAnalytics,
  recent: IronwoodMigrationTx[],
  overviewTotal: number
): IronwoodAnalytics {
  if (!recent.length) return analytics
  const existingIds = new Set(analytics.transactions.map((tx) => tx.txid))
  const recentIds = new Set(recent.map((tx) => tx.txid))
  const additions = recent.filter((tx) => !existingIds.has(tx.txid))
  const transactions = [
    ...recent,
    ...analytics.transactions.filter((tx) => !recentIds.has(tx.txid)),
  ].sort(
    (a, b) =>
      (b.timestamp ?? 0) - (a.timestamp ?? 0) || b.height - a.height
  )
  const total = Math.max(analytics.total, overviewTotal, transactions.length)
  const classificationGap = Math.max(0, total - analytics.total)
  const newlyClassified = additions.slice(0, classificationGap)
  const newDenominated = newlyClassified.filter(
    (tx) => tx.privacy === "denominated"
  )
  const newDistinctive = newlyClassified.filter(
    (tx) => tx.privacy === "distinctive"
  )
  const denominatedCount =
    analytics.denominatedCount + newDenominated.length
  const distinctiveCount =
    analytics.distinctiveCount + newDistinctive.length
  return {
    ...analytics,
    total,
    denominatedCount,
    distinctiveCount,
    denominatedPercent: total > 0 ? (denominatedCount / total) * 100 : 0,
    denominatedVolumeZec:
      analytics.denominatedVolumeZec +
      newDenominated.reduce((sum, tx) => sum + tx.amountZec, 0),
    distinctiveVolumeZec:
      analytics.distinctiveVolumeZec +
      newDistinctive.reduce((sum, tx) => sum + tx.amountZec, 0),
    transactions,
  }
}

export async function GET() {
  const kv = await getKv()
  const now = Date.now()
  const errors: string[] = []
  const cachedLive = await readEnvelope<LiveSnapshot>(kv, LIVE_KEY)

  let live = cachedLive
  let liveStale = false
  if (!cachedLive || now - cachedLive.fetchedAt >= LIVE_FRESH_MS) {
    try {
      const value = await refreshLive()
      live = { value, fetchedAt: Date.now(), activated: value.overview.activated }
      await writeEnvelope(kv, LIVE_KEY, live)
    } catch (error) {
      liveStale = true
      errors.push(error instanceof Error ? error.message : "Live refresh failed")
    }
  }

  if (!live) {
    return NextResponse.json(
      { error: "Ironwood live data is temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }

  const activated = live.value.overview.activated
  const cachedAnalytics = await readEnvelope<IronwoodAnalytics>(
    kv,
    ANALYTICS_KEY
  )
  const analyticsFreshMs = activated
    ? ANALYTICS_FRESH_MS
    : PRE_ACTIVATION_ANALYTICS_FRESH_MS
  const activationChanged =
    cachedAnalytics?.activated != null &&
    cachedAnalytics.activated !== activated

  let analytics = cachedAnalytics
  let analyticsStale = false
  if (
    !cachedAnalytics ||
    activationChanged ||
    now - cachedAnalytics.fetchedAt >= analyticsFreshMs
  ) {
    try {
      const value = activated ? await refreshAnalytics() : emptyAnalytics()
      analytics = { value, fetchedAt: Date.now(), activated }
      await writeEnvelope(kv, ANALYTICS_KEY, analytics)
    } catch (error) {
      analyticsStale = true
      errors.push(
        error instanceof Error ? error.message : "Analytics refresh failed"
      )
    }
  }

  const mergedAnalytics = mergeRecentMigrations(
    analytics?.value ?? emptyAnalytics(),
    live.value.recentMigrations ?? [],
    live.value.overview.migration.txCount
  )
  const payload: IronwoodLiveResponse = {
    success: true,
    overview: live.value.overview,
    blocks: live.value.blocks,
    mempool: live.value.mempool,
    analytics: mergedAnalytics,
    liveFetchedAt: live.fetchedAt,
    analyticsFetchedAt: analytics?.fetchedAt ?? null,
    fetchedAt: Date.now(),
    ...(liveStale || analyticsStale ? { stale: true } : {}),
    ...(errors.length ? { errors } : {}),
  }

  return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
}
