import { NextResponse } from "next/server"

// Reference values for the /what-if page that don't have a clean live
// API to fetch from — offshore wealth, total above-ground gold supply,
// and the fallback gold spot used when Yahoo's gold-futures chip is
// unreachable. The numbers live in public/data/static-markets.json so
// updates only need a JSON commit, not a code change.
//
// We don't read the file from disk — Cloudflare Workers doesn't ship
// the public/ directory into the worker bundle (it's served via the
// ASSETS binding for static asset requests). Instead we fetch the
// static asset from our own origin. The asset response is cached at
// the CF edge so this round-trip is effectively free after the first
// request in each region. A 5min revalidate keeps the JSON warm
// without hammering the asset binding.

export const runtime = "edge"
export const dynamic = "force-dynamic"
export const revalidate = 300

interface StaticMarkets {
  offshoreWealth: {
    usd: number
    asOf: string
    source: string
    sourceUrl?: string
  }
  goldSupply: {
    troyOz: number
    asOf: string
    source: string
    sourceUrl?: string
  }
  goldPriceFallbackUsd: {
    value: number
    asOf: string
    source: string
    sourceUrl?: string
  }
}

// Hard-coded fallback served when the asset fetch fails (cold cache +
// network blip, dev environment with no static asset binding, etc).
// Matches the bundled JSON values so the page renders consistently
// either way; the asOf dates surface to the UI so users always know
// when each figure was last reviewed.
const FALLBACK: StaticMarkets = {
  offshoreWealth: {
    usd: 11.3e12,
    asOf: "2024-06",
    source: "BCG Global Wealth Report 2024",
    sourceUrl:
      "https://www.bcg.com/publications/2024/global-wealth-report-2024-the-gen-ai-era-unfolds",
  },
  goldSupply: {
    troyOz: 7.5e9,
    asOf: "2024-12",
    source: "World Gold Council — all-time mined gold",
    sourceUrl: "https://www.gold.org/goldhub/data/how-much-gold",
  },
  goldPriceFallbackUsd: {
    value: 4200,
    asOf: "2026-05",
    source:
      "Recent gold spot range — used only when /api/ticker is unreachable",
    sourceUrl: "https://www.gold.org/goldhub/data/gold-prices",
  },
}

export async function GET(request: Request) {
  // Resolve the static asset off our own origin. Origin comes from the
  // incoming request URL so this works whether we're on cyphzec.com,
  // beta.cyphzec.com, or a Workers preview deployment.
  const url = new URL(request.url)
  const assetUrl = `${url.origin}/data/static-markets.json`

  try {
    // CF caches static assets aggressively — `cache: "force-cache"`
    // lets the runtime serve a cached copy even when this route is
    // running with dynamic = "force-dynamic" for the JSON output.
    const resp = await fetch(assetUrl, {
      cf: { cacheTtl: 300 },
      // @ts-expect-error - cf-specific init field not in standard typings
      cache: "force-cache",
    } as RequestInit)
    if (!resp.ok) throw new Error(`asset ${assetUrl} → ${resp.status}`)
    const data = (await resp.json()) as StaticMarkets
    // Light shape check — if the asset is missing a field we want, fall
    // through to the hard-coded values rather than serving partial JSON
    // that would crash the client.
    if (
      data?.offshoreWealth?.usd == null ||
      data?.goldSupply?.troyOz == null ||
      data?.goldPriceFallbackUsd?.value == null
    ) {
      throw new Error("static-markets.json missing required fields")
    }
    return NextResponse.json(data, {
      headers: {
        // 5 min fresh + 24h stale-while-revalidate. The values move
        // slowly enough that stale is fine; the daily GitHub Actions
        // warmer (.github/workflows/refresh-cache.yml) ensures at
        // least one fresh fetch per day even when traffic is quiet.
        "Cache-Control":
          "public, max-age=300, stale-while-revalidate=86400",
      },
    })
  } catch (err) {
    // Log + serve fallback. We never want this endpoint to 500 because
    // the /what-if table depends on it — the fallback values match the
    // bundled JSON so the page renders the same numbers either way.
    console.warn("[api/static-markets] asset fetch failed:", err)
    return NextResponse.json(FALLBACK, {
      headers: {
        "Cache-Control":
          "public, max-age=60, stale-while-revalidate=300",
      },
    })
  }
}
