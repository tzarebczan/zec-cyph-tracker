import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { WhatIfTable } from "@/components/what-if"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/what-if`
const TITLE = "What ZEC Could Be Worth — Market Capture Scenarios"
const DESCRIPTION =
  "If ZEC captures a fraction of Bitcoin, gold, offshore wealth, stablecoins, or Dogecoin's market cap — implied ZEC prices, computed live from current market data."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    type: "article",
  },
  twitter: {
    title: TITLE,
    description: DESCRIPTION,
  },
}

// The /what-if page renders the same WhatIfTable component that the
// /stats page exposes under its WHAT IF tab — so any future polish to
// the valuation table lands on both surfaces from one edit. EShell's
// `active="rank"` lights up the STATS bottom-tab on mobile, since this
// page is conceptually a sibling of /stats (both answer "where does
// ZEC sit relative to other assets").
export default function WhatIfPage() {
  return (
    <EShell active="rank">
      <WhatIfTable />
    </EShell>
  )
}
