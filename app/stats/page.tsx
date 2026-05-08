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

// ISR: regenerate every hour. This refreshes the metadata (so the OG
// cache-bust below picks up the new daily stamp) and gives the body's
// SSR-prefetched copy a chance to update without making the page fully
// dynamic. SWR on the client still keeps live numbers fresh per visit.
export const revalidate = 3600

export async function generateMetadata(): Promise<Metadata> {
  // Daily-granularity cache buster on the OG URL — Twitter / Facebook
  // re-fetch the OG image when the URL changes, so bumping the `?d=`
  // param once per UTC day prompts socials to pull a fresh snapshot
  // (current ZEC rank, shielded %, mcap perf) on each share-day. The
  // image route itself is CF-edge cached for 3h independent of this.
  const today = new Date()
  const stamp = today.toISOString().slice(0, 10).replace(/-/g, "") // YYYYMMDD
  const ogUrl = `/api/og/stats?d=${stamp}`
  const ogImage = {
    url: ogUrl,
    width: 1200,
    height: 630,
    alt: `Zcash (ZEC) market-cap rank, shielded supply %, and 7D/30D mcap performance — live snapshot ${stamp}`,
  }
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: PAGE_URL },
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: PAGE_URL,
      type: "article",
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [ogUrl],
    },
  }
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
            Rankings &amp; Supply
          </h1>
        </div>

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
