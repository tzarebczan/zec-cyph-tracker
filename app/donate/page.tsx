import type { Metadata } from "next"
import { Donate } from "@/components/donate"

export const metadata: Metadata = {
  title: "Donate",
  description:
    "Optional ZEC donation to CyphZec. Scan a ZIP 321 QR or copy the shielded unified address.",
}

export default function DonatePage() {
  return <Donate />
}
