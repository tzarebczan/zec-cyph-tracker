import type { Metadata } from "next"
import { IronwoodDashboard } from "@/components/ironwood-dashboard"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/ironwood`
const TITLE = "Ironwood Live - Zcash NU6.3 Migration Tracker"
const DESCRIPTION =
  "Live block-by-block tracking for the Zcash Ironwood activation and Orchard-to-Ironwood migration, including mempool transactions, pool flow, privacy cohorts, and supply verification."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function IronwoodPage() {
  return <IronwoodDashboard />
}
