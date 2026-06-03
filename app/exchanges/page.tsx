import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { ExchangesTab } from "@/components/exchanges-tab"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/exchanges`
const TITLE = "ZEC Exchange Stats - Live Venue Volume & Market Share"
const DESCRIPTION =
  "Live ZEC exchange volume distribution by venue and trading pair, including 24h volume share, venue concentration, and rolling volume changes."

export const revalidate = 3600

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
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function ExchangesPage() {
  return (
    <EShell active="exchanges">
      <ExchangesTab />
    </EShell>
  )
}
