import type { Metadata } from "next"
import { BitcoinZec } from "@/components/bitcoin"
import { EShell } from "@/components/shell"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/bitcoin`
const TITLE = "Bitcoin / ZEC - Live Ratio, Relative Strength & Rainbow Watch"
const DESCRIPTION =
  "Track Bitcoin and Zcash live prices, the ZEC/BTC ratio, relative performance, market caps, circulating supply, and Bitcoin's live power-law rainbow position."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
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

export default function BitcoinPage() {
  return (
    <EShell active="bitcoin">
      <BitcoinZec />
    </EShell>
  )
}
