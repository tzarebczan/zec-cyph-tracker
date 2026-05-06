import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { EstimatorClient, EstimatorHeader } from "@/components/estimator-client"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/estimator`
const TITLE =
  "$CYPH Price Estimator — Predict Cypherpunk Stock Price from Zcash (ZEC)"
const DESCRIPTION =
  "Estimate $CYPH (Cypherpunk Technologies, NASDAQ) stock price for any potential $ZEC / Zcash price. Uses live, 7-day, 30-day, 90-day, and all-time average CYPH/ZEC ratios. Also shows the last time ZEC was at the target price and what CYPH was trading at then."

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
        { "@type": "ListItem", position: 2, name: "Estimator", item: PAGE_URL },
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

export default function EstimatorPage() {
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
        <EstimatorHeader />
        <p className="text-sm text-muted-foreground leading-relaxed">
          Estimate the price of $CYPH (
          <span className="text-foreground">Cypherpunk Technologies</span>,
          NASDAQ) for any potential $ZEC / Zcash price, using historical
          CYPH/ZEC ratios over different time windows. Also surfaces the
          most recent dates Zcash closed near your target price and what
          CYPH was trading at then.
        </p>

        <EstimatorClient />
      </main>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  )
}
