import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { Unshieldings } from "@/components/unshieldings"

const PAGE_URL = "https://cyphzec.com/shielding/unshieldings"
const TITLE = "ZEC Unshieldings - Transparent Follow-Up Trace"
const DESCRIPTION =
  "Track ZEC deshielding transactions since NU6.2 and classify what happens after funds land on transparent addresses."

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

export default function UnshieldingsPage() {
  return (
    <EShell active="shielding">
      <Unshieldings />
    </EShell>
  )
}
