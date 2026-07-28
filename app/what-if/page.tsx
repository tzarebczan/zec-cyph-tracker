import type { Metadata } from "next"
import { WhatIfTable } from "@/components/what-if"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/what-if`
const TITLE = "What ZEC Could Be Worth — Market Capture Scenarios"
const DESCRIPTION =
  "If ZEC captures a fraction of Bitcoin, gold, offshore wealth, stablecoins, or Dogecoin's market cap — implied ZEC prices, computed live from current market data."

type MetadataSearchParams = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: MetadataSearchParams
}): Promise<Metadata> {
  const params = searchParams ? await searchParams : {}
  const btcBasis = params.btcBasis === "price" ? "price" : "mcap"
  // Hour-grain cache buster on the OG. The OG image route itself is
  // CF-edge-cached for 1h (s-maxage=3600) — combined, every hour we
  // mint a new URL pointing to a freshly-rendered PNG. Same pattern
  // as the root layout's OG.
  const hourStamp = new Date()
    .toISOString()
    .slice(0, 13)
    .replace(/[-T]/g, "") // YYYYMMDDHH
  const ogUrl = `/api/og/what-if?h=${hourStamp}&btcBasis=${btcBasis}`

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: PAGE_URL },
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: PAGE_URL,
      type: "article",
      images: [
        {
          url: ogUrl,
          width: 1200,
          height: 630,
          alt: "What ZEC could be worth — implied price scenarios across Bitcoin, gold, offshore wealth, stablecoins, global economy, and Dogecoin",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [ogUrl],
    },
  }
}

export default function WhatIfPage() {
  return <WhatIfTable />
}
