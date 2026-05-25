import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { Stats } from "@/components/stats"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/stats`
const TITLE = "ZEC Stats — Rankings, Supply, Shielded Pools & Transactions"
const DESCRIPTION =
  "Live ZEC market rank vs the top 50, what it would take to flip the next coin, shielded supply across Orchard / Sapling / Sprout pools, daily transaction counts and a 7d/30d/90d/1Y market cap history. Plus the WHAT IF valuation table."

// ISR: regenerate metadata hourly so `generateMetadata` mints a new
// `?h=YYYYMMDDHH` cache buster on the OG URL each hour. Same pattern
// as /what-if + the root layout — Twitter / Facebook re-fetch a new
// URL each hour and the social embed refreshes.
export const revalidate = 3600

export async function generateMetadata(): Promise<Metadata> {
  const hourStamp = new Date()
    .toISOString()
    .slice(0, 13)
    .replace(/[-T]/g, "") // YYYYMMDDHH
  const ogUrl = `/api/og/stats?h=${hourStamp}`

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
          alt: "Live ZEC market stats — rank, flip target, shielded supply, and recent mcap performance",
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

export default function StatsPage() {
  return (
    <EShell active="rank">
      <Stats />
    </EShell>
  )
}
