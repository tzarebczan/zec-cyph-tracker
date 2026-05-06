import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, Wallet } from "lucide-react"
import { PortfolioClient } from "@/components/portfolio-client"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/portfolio`
const TITLE =
  "$CYPH + $ZEC Portfolio Tracker — Track Cypherpunk Stock & Zcash Holdings"
const DESCRIPTION =
  "Track your $CYPH (Cypherpunk Technologies, NASDAQ) and $ZEC (Zcash) holdings with a fully local portfolio tracker. Live total value, 24h / 7d / 30d / 90d performance, asset breakdown, and a value-over-time chart. Saved only on your device — nothing leaves your browser."

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
    title: TITLE,
    description: DESCRIPTION,
  },
  // The page is interactive (localStorage form) — there's no shareable
  // public state, but we still want it crawlable for the empty-state
  // copy and the SEO keywords.
  robots: { index: true, follow: true },
}

const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${PAGE_URL}#webpage`,
    url: PAGE_URL,
    name: TITLE,
    description: DESCRIPTION,
    isPartOf: { "@id": `${SITE_URL}#website` },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Portfolio", item: PAGE_URL },
      ],
    },
    about: [
      {
        "@type": "Corporation",
        name: "Cypherpunk Technologies Inc.",
        alternateName: [
          "Cypherpunk Technologies",
          "Cypherpunk Holdings",
          "Cypherpunk",
          "CYPH",
        ],
        tickerSymbol: "CYPH",
        url: "https://www.cypherpunkholdings.com/",
      },
      {
        "@type": "Thing",
        name: "Zcash",
        alternateName: ["ZEC", "$ZEC", "Zcash cryptocurrency"],
        url: "https://z.cash/",
      },
    ],
  },
]

export default function PortfolioPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-3 py-2 flex items-center gap-2">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>
              Back to{" "}
              <span aria-hidden="true">
                <span style={{ color: "#34d399" }}>$CYPH</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span style={{ color: "#fb923c" }}>$ZEC</span>
              </span>
              <span className="sr-only">CYPH / ZEC dashboard</span>
            </span>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-3 py-4 md:py-8 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-primary" />
          <h1 className="text-lg md:text-xl font-mono font-bold text-foreground">
            $CYPH + $ZEC Portfolio Tracker
          </h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Track your $CYPH (Cypherpunk Technologies) and $ZEC (Zcash) holdings
          with live total value, performance over multiple windows, and a
          value chart. Stored only on your device.
        </p>

        <PortfolioClient />
      </main>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  )
}
