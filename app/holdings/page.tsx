import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, Landmark } from "lucide-react"
import { HoldingsClient } from "@/components/holdings-client"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/holdings`
const TITLE =
  "Cypherpunk Technologies (CYPH) Treasury — ZEC Holdings & Transactions"
const DESCRIPTION =
  "Live tracker of Cypherpunk Technologies' (NASDAQ: CYPH) ZEC treasury: total Zcash held, average cost per ZEC, full transaction history, and current value at the live ZEC price. Sourced from cypherpunk.com."

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
        { "@type": "ListItem", position: 2, name: "Holdings", item: PAGE_URL },
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

export default function HoldingsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-3 py-2 flex items-center gap-2">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
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
          <Landmark className="size-5 text-primary" />
          <h1 className="text-lg md:text-xl font-mono font-semibold text-foreground">
            CYPH Treasury &middot; ZEC Holdings
          </h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Cypherpunk Technologies&rsquo; ZEC treasury — total Zcash held,
          weighted-average cost basis, current value at the live ZEC price,
          and full purchase history. Data sourced live from{" "}
          <a
            href="https://cypherpunk.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            cypherpunk.com
          </a>
          .
        </p>

        <HoldingsClient />
      </main>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  )
}
