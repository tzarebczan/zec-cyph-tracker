import type { Metadata } from "next"
import { ExchangesTab } from "@/components/exchanges-tab"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/exchanges`
const TITLE = "ZEC Exchange Stats - Live Venue Volume & Market Share"
const DESCRIPTION =
  "Live ZEC exchange volume distribution by venue and trading pair, including 24h volume share, venue concentration, and rolling volume changes."

export async function generateMetadata(): Promise<Metadata> {
  const hourStamp = new Date()
    .toISOString()
    .slice(0, 13)
    .replace(/[-T]/g, "")
  const ogUrl = `/api/og/exchanges?h=${hourStamp}`

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
          alt: "Live ZEC exchange stats with venue volume share and top trading pairs",
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

export default function ExchangesPage() {
  return <ExchangesTab />
}
