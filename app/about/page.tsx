import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { SeoContent } from "@/components/seo-content"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/about`
const TITLE = "About the CYPH/ZEC Ratio — FAQ & Data Sources"
const DESCRIPTION =
  "How the CYPH/ZEC ratio is calculated, what Cypherpunk Technologies (NASDAQ: CYPH) and Zcash ($ZEC) are, where the price data comes from, and how the Blue Ocean ATS overnight session works. Frequently asked questions about cyphzec.com."

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

// Page-scoped Schema.org. WebPage describes /about specifically; FAQPage
// must live on the same URL the FAQ is rendered on (Google's policy), so
// it moved out of the root layout when we extracted this page.
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
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: SITE_URL,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "About",
          item: PAGE_URL,
        },
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
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${PAGE_URL}#faq`,
    mainEntity: [
      {
        "@type": "Question",
        name: "What is the CYPH/ZEC ratio?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "The CYPH/ZEC ratio is the price of one share of Cypherpunk Technologies Inc. (NASDAQ: CYPH) divided by the spot price of one Zcash (ZEC) coin. Because Cypherpunk Technologies holds ZEC on its balance sheet, the ratio gives a quick read on whether the stock trades at a premium or discount to its underlying ZEC reserves.",
        },
      },
      {
        "@type": "Question",
        name: "When did CYPH start holding ZEC?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Cypherpunk Technologies began holding ZEC on its balance sheet on November 12, 2025. The historical chart on cyphzec.com starts from that date.",
        },
      },
      {
        "@type": "Question",
        name: "Where does the price data come from?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "$CYPH quotes (regular session, pre-market, after-hours, and overnight Blue Ocean ATS) come from Yahoo Finance. $ZEC spot price comes from Kraken. Both feeds refresh roughly every 30 to 60 seconds.",
        },
      },
      {
        "@type": "Question",
        name: "What is the Blue Ocean ATS overnight session?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Blue Ocean ATS is an alternative trading system that runs from 8 PM to 4 AM ET, Sunday through Thursday. It lets US-listed stocks like CYPH trade overnight while the regular NASDAQ session is closed. This tracker surfaces the latest overnight tick alongside the regular and post-market prices.",
        },
      },
      {
        "@type": "Question",
        name: "Is cyphzec.com affiliated with Cypherpunk Technologies or Zcash?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "No. cyphzec.com is an independent price tracker. It is not affiliated with, endorsed by, or sponsored by Cypherpunk Technologies Inc. or the Electric Coin Company / Zcash Foundation.",
        },
      },
    ],
  },
]

export default function AboutPage() {
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
        <SeoContent />
      </main>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  )
}
