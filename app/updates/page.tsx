import type { Metadata } from "next"
import { EShell } from "@/components/shell"
import { Updates } from "@/components/updates"

const PAGE_URL = "https://cyphzec.com/updates"
const TITLE = "CYPH ZEC Features and Updates"
const DESCRIPTION =
  "New cyphzec.com tools, beta features, and release notes."

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

export default function UpdatesPage() {
  return (
    <EShell active="more">
      <Updates />
    </EShell>
  )
}
