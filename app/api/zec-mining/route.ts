import { NextResponse } from "next/server"
import type { ZecMiningDay, ZecMiningNetwork } from "@/lib/cyph-mining"

// ZEC network mining economics from cipherscan's Zebra node.
//
// /api/zec-stats reads the same upstream, but only for the supply block and on
// a supply-shaped cache (a day-scale figure kept in KV). Hashrate and
// difficulty move continuously, so they get their own short window here rather
// than being wedged into the shielded-breakdown cache and its shared type.
//
// The daily history is what turns Cypherpunk's published ZEC-mined figure into
// an implied fleet hashrate (see lib/cyph-mining.ts): blocks actually found
// per day give the ZEC the network paid miners over the disclosed period, and
// the day's hashrate says how much of the network a given share of that was.

const CIPHERSCAN_STATS_URL = "https://api.mainnet.cipherscan.app/api/network/stats"
// 180d is the longest window cipherscan serves below 1y; it comfortably covers
// every disclosure period since mining went live on 2026-08-18 and keeps the
// payload around 20KB.
const CIPHERSCAN_HISTORY_URL =
  "https://api.mainnet.cipherscan.app/api/network/hashrate-history?period=180d"
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600",
}
const UPSTREAM_HEADERS = {
  Accept: "application/json",
  Origin: "https://cipherscan.app",
  Referer: "https://cipherscan.app/network",
}

interface CipherscanMining {
  mining?: {
    networkHashrateRaw?: number
    networkHashrate?: string
    difficulty?: number
    avgBlockTime?: number
    blocks24h?: number
    blockReward?: number
    minerReward?: number
    dailyMinerRevenue?: number
  }
}

interface CipherscanHistory {
  points?: {
    date?: string
    avgDifficulty?: number
    blockCount?: number
    hashrate?: number
  }[]
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

export interface ZecMiningResponse extends ZecMiningNetwork {
  source: string
  fetchedAt: number
  stale?: boolean
  message?: string
}

async function fetchStats(): Promise<CipherscanMining> {
  const res = await fetch(CIPHERSCAN_STATS_URL, {
    headers: UPSTREAM_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`cipherscan HTTP ${res.status}`)
  return (await res.json()) as CipherscanMining
}

/** History failure is non-fatal: the live figures still render, only the
 *  disclosure-calibrated estimate falls back to the stated fleet size. */
async function fetchHistory(): Promise<ZecMiningDay[]> {
  try {
    const res = await fetch(CIPHERSCAN_HISTORY_URL, {
      headers: UPSTREAM_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as CipherscanHistory
    return (json.points ?? [])
      .map((p) => ({
        date: typeof p.date === "string" ? p.date.slice(0, 10) : "",
        blocks: finite(p.blockCount) ?? 0,
        hashrateSolS: finite(p.hashrate),
        difficulty: finite(p.avgDifficulty),
      }))
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.hashrateSolS != null)
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

export async function GET() {
  const fetchedAt = Date.now()
  try {
    const [json, history] = await Promise.all([fetchStats(), fetchHistory()])
    const m = json.mining ?? {}

    const payload: ZecMiningResponse = {
      networkSolS: finite(m.networkHashrateRaw),
      // minerReward is the miner's slice per block; blockReward also carries
      // the funding streams and lockbox, which miners never receive.
      minerRewardPerBlock: finite(m.minerReward),
      dailyMinerRevenueZec: finite(m.dailyMinerRevenue),
      blocks24h: finite(m.blocks24h),
      avgBlockTimeSecs: finite(m.avgBlockTime),
      difficulty: finite(m.difficulty),
      history,
      source: CIPHERSCAN_STATS_URL,
      fetchedAt,
    }
    if (payload.networkSolS == null) {
      throw new Error("cipherscan returned no network hashrate")
    }
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (err) {
    return NextResponse.json(
      {
        networkSolS: null,
        minerRewardPerBlock: null,
        dailyMinerRevenueZec: null,
        blocks24h: null,
        avgBlockTimeSecs: null,
        difficulty: null,
        history: [],
        source: CIPHERSCAN_STATS_URL,
        fetchedAt,
        stale: true,
        message: err instanceof Error ? err.message : "mining fetch failed",
      } satisfies ZecMiningResponse,
      { headers: RESPONSE_HEADERS }
    )
  }
}
