import { NextResponse } from "next/server"

const CYPHERPUNK_URL = "https://cypherpunk.com/"
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=900",
}

function normaliseFlightHtml(html: string) {
  return html.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\$\$/g, "$")
}

function extractIndicatorValue(html: string, slug: string): string | null {
  const marker = `"indicatorSlug":"${slug}"`
  const index = html.indexOf(marker)
  if (index < 0) return null
  const chunk = html.slice(Math.max(0, index - 700), index + marker.length)
  const matches = Array.from(chunk.matchAll(/"value":"([^"]*)"/g))
  return matches.length > 0 ? matches[matches.length - 1][1] : null
}

function parseCompactNumber(raw: string | null): number | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim()
  if (!cleaned || cleaned === "-" || cleaned.toLowerCase() === "n/a") {
    return null
  }

  const suffix = cleaned.slice(-1).toUpperCase()
  const multiplier =
    suffix === "T"
      ? 1_000_000_000_000
      : suffix === "B"
        ? 1_000_000_000
        : suffix === "M"
          ? 1_000_000
          : suffix === "K"
            ? 1_000
            : 1
  const numeric = Number.parseFloat(multiplier === 1 ? cleaned : cleaned.slice(0, -1))
  return Number.isFinite(numeric) ? numeric * multiplier : null
}

export async function GET() {
  const fetchedAt = Date.now()
  try {
    const res = await fetch(CYPHERPUNK_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 },
    })
    if (!res.ok) throw new Error(`cypherpunk.com HTTP ${res.status}`)

    const html = normaliseFlightHtml(await res.text())
    const mnav = parseCompactNumber(extractIndicatorValue(html, "mnav_new"))
    const enterpriseValue = parseCompactNumber(
      extractIndicatorValue(html, "enterprise_value")
    )
    const marketCap = parseCompactNumber(
      extractIndicatorValue(html, "market_capitalization")
    )
    const fullyDilutedShares = parseCompactNumber(
      extractIndicatorValue(html, "cyph_fully_diluted_shares")
    )
    const zecHoldings = parseCompactNumber(
      extractIndicatorValue(html, "zec_holdings")
    )
    const netAssetValue =
      enterpriseValue != null && mnav != null && mnav > 0
        ? enterpriseValue / mnav
        : null

    return NextResponse.json(
      {
        mnav,
        enterpriseValue,
        netAssetValue,
        marketCap,
        fullyDilutedShares,
        zecHoldings,
        source: "cypherpunk.com",
        fetchedAt,
      },
      { headers: RESPONSE_HEADERS }
    )
  } catch (err) {
    return NextResponse.json(
      {
        mnav: null,
        enterpriseValue: null,
        netAssetValue: null,
        marketCap: null,
        fullyDilutedShares: null,
        zecHoldings: null,
        source: "cypherpunk.com",
        fetchedAt,
        stale: true,
        message: err instanceof Error ? err.message : "mNAV fetch failed",
      },
      { headers: RESPONSE_HEADERS }
    )
  }
}
