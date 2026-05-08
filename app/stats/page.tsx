import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, BarChart3 } from "lucide-react"
import { StatsClient } from "@/components/stats-client"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/stats`
const TITLE =
  "Crypto Market Cap Rankings + Zcash (ZEC) Supply Stats"
const DESCRIPTION =
  "Live top-50 cryptocurrency market cap leaderboard with Zcash highlighted, plus how much $ZEC's price would need to move to overtake (or be overtaken by) each ranked coin. Plus ZEC supply stats: circulating, max supply, and shielded pool data."

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
        { "@type": "ListItem", position: 2, name: "Stats", item: PAGE_URL },
      ],
    },
    about: [
      {
        "@type": "Thing",
        name: "Zcash",
        alternateName: ["ZEC", "$ZEC", "Zcash cryptocurrency"],
        url: "https://z.cash/",
      },
    ],
  },
]

export default function StatsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
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

      <main className="max-w-4xl mx-auto px-3 py-4 md:py-8 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-lg md:text-xl font-mono font-bold text-foreground">
            Crypto Market Cap Rankings &amp; $ZEC Supply
          </h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Live top-50 leaderboard by market cap with Zcash highlighted, plus
          how much $ZEC&apos;s price would need to move to flip each
          neighbour. Supply tab tracks circulating, max-supply progress,
          and shielded pool data.
        </p>

        <StatsClient />
      </main>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  )
}
