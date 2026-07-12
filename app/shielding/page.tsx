import type { Metadata } from "next"
import { ShieldingDetails } from "@/components/shielding-details"

const PAGE_URL = "https://cyphzec.com/shielding"
const TITLE = "ZEC Shielding Details - Live In/Out Flow Monitor"
const DESCRIPTION =
  "Track post-NU6.2 ZEC shielding and unshielding flows by block, hour, day, and 7-day window."

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

export default function ShieldingPage() {
  return <ShieldingDetails />
}
