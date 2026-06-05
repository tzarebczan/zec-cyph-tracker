import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { ShieldingDetails } from "@/components/shielding-details"

const PAGE_URL = "https://cyphzec.com/shielding"

export const metadata: Metadata = {
  title: "Shielding Details | CYPH ZEC",
  description:
    "Track post-NU6.2 ZEC shielding and unshielding flows by block, hour, day, and 7-day window.",
  alternates: {
    canonical: PAGE_URL,
  },
}

export default function ShieldingPage() {
  return (
    <EShell active="shielding">
      <ShieldingDetails />
    </EShell>
  )
}
