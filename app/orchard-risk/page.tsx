import type { Metadata } from "next"
import { OrchardRiskDetails } from "@/components/orchard-risk"
import { EShell } from "@/components/shell"

const PAGE_URL = "https://cyphzec.com/orchard-risk"
const TITLE = "Orchard Risk Market - Polymarket Signal"
const DESCRIPTION =
  "Track Polymarket odds for whether Zcash's Orchard pool vulnerability is confirmed exploited."

export const metadata: Metadata = {
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
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function OrchardRiskPage() {
  return (
    <EShell active="shielding">
      <OrchardRiskDetails />
    </EShell>
  )
}
