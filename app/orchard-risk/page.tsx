import type { Metadata } from "next"
import { OrchardRiskDetails } from "@/components/orchard-risk"
import { EShell } from "@/components/shell"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/orchard-risk`
const TITLE = "Orchard Risk Market - Polymarket Signal"
const DESCRIPTION =
  "Track Polymarket odds for whether Zcash's Orchard pool vulnerability is confirmed exploited."

export const revalidate = 3600

export async function generateMetadata(): Promise<Metadata> {
  const hourStamp = new Date()
    .toISOString()
    .slice(0, 13)
    .replace(/[-T]/g, "")
  const ogUrl = `/api/og/orchard-risk?h=${hourStamp}`

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: {
      canonical: PAGE_URL,
    },
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
          alt: "Polymarket signal for whether Zcash's Orchard pool vulnerability is confirmed exploited",
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

export default function OrchardRiskPage() {
  return (
    <EShell active="shielding">
      <OrchardRiskDetails />
    </EShell>
  )
}
