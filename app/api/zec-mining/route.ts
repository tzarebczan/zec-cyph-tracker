import { NextResponse } from "next/server"
import type { ZecMiningNetwork } from "@/lib/cyph-mining"

// ZEC network mining economics from cipherscan's Zebra node.
//
// /api/zec-stats reads the same upstream, but only for the supply block and on
// a supply-shaped cache (a day-scale figure kept in KV). Hashrate and
// difficulty move continuously, so they get their own short window here rather
// than being wedged into the shielded-breakdown cache and its shared type.

const CIPHERSCAN_URL = "https://api.mainnet.cipherscan.app/api/network/stats"
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600",
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

export async function GET() {
  const fetchedAt = Date.now()
  try {
    const res = await fetch(CIPHERSCAN_URL, {
      headers: {
        Accept: "application/json",
        Origin: "https://cipherscan.app",
        Referer: "https://cipherscan.app/network",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) throw new Error(`cipherscan HTTP ${res.status}`)
    const json = (await res.json()) as CipherscanMining
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
      source: CIPHERSCAN_URL,
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
        source: CIPHERSCAN_URL,
        fetchedAt,
        stale: true,
        message: err instanceof Error ? err.message : "mining fetch failed",
      } satisfies ZecMiningResponse,
      { headers: RESPONSE_HEADERS }
    )
  }
}
