import { NextResponse } from "next/server"
import {
  extractMining,
  fetchCypherpunkSite,
  type CypherpunkMining,
} from "@/lib/cypherpunk-site"

// Valuation figures scraped from cypherpunk.com's homepage payload. See
// lib/cypherpunk-site.ts for why we read the computed block rather than the
// CMS display strings this route used to match on — those were stale by tens
// of percent, and the `indicatorSlug` markers they hung off no longer exist
// after the August 2026 revamp, which left every field here null.

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=900",
}

export interface CypherpunkMnavResponse {
  mnav: number | null
  enterpriseValue: number | null
  netAssetValue: number | null
  marketCap: number | null
  fullyDilutedShares: number | null
  zecHoldings: number | null
  /** Disclosed mining investment, or null before any is reported. */
  mining: CypherpunkMining | null
  source: string
  fetchedAt: number
  stale?: boolean
  message?: string
}

export async function GET() {
  const fetchedAt = Date.now()
  try {
    const { metrics, treasuryTxns } = await fetchCypherpunkSite()
    // mnav is published directly; derive it only if that field ever goes
    // missing, since EV / NAV is exactly how they define it.
    const mnav =
      metrics.mnav ??
      (metrics.enterpriseValue != null &&
      metrics.netAssetValue != null &&
      metrics.netAssetValue > 0
        ? metrics.enterpriseValue / metrics.netAssetValue
        : null)

    const payload: CypherpunkMnavResponse = {
      mnav,
      enterpriseValue: metrics.enterpriseValue,
      netAssetValue: metrics.netAssetValue,
      marketCap: metrics.marketCapitalization,
      fullyDilutedShares: metrics.fullyDilutedShares,
      zecHoldings: metrics.zecHoldings,
      mining: extractMining(treasuryTxns),
      source: "cypherpunk.com",
      fetchedAt,
    }
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (err) {
    return NextResponse.json(
      {
        mnav: null,
        enterpriseValue: null,
        netAssetValue: null,
        marketCap: null,
        fullyDilutedShares: null,
        zecHoldings: null,
        mining: null,
        source: "cypherpunk.com",
        fetchedAt,
        stale: true,
        message: err instanceof Error ? err.message : "mNAV fetch failed",
      } satisfies CypherpunkMnavResponse,
      { headers: RESPONSE_HEADERS }
    )
  }
}
