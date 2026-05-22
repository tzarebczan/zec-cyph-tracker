import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./beta.css"

// The root layout (app/layout.tsx) already imports globals.css + JSON-LD;
// this layout just sets a beta-specific page title so search engines see
// these as variants of the main routes, not duplicates. `robots:
// noindex` prevents Google from competing with the production URLs
// during the beta period — once we swap, beta.cyphzec.com goes away
// and the canonical URLs absorb traffic naturally.
export const metadata: Metadata = {
  title: {
    default: "CYPH / ZEC · beta",
    template: "%s · CYPH / ZEC beta",
  },
  description:
    "Cypherpunk-terminal redesign of the CYPH / ZEC tracker. Beta preview.",
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  alternates: { canonical: "https://beta.cyphzec.com" },
}

export default function BetaLayout({ children }: { children: ReactNode }) {
  return <div data-beta="on">{children}</div>
}
