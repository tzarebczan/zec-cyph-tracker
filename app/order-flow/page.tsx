import type { Metadata } from "next"
import { OrderFlowView } from "@/components/order-flow-view"

const SITE_URL = "https://cyphzec.com"
const PAGE_URL = `${SITE_URL}/order-flow`
const TITLE = "ZEC Order Flow - Aggregated Depth, Taker Tape & Price Action"
const DESCRIPTION =
  "Live ZEC order-book depth aggregated across seven exchanges and thirteen markets, with the liquidity ladder, market impact, resting walls, taker tape and intraday price action."

export async function generateMetadata(): Promise<Metadata> {
  const hourStamp = new Date()
    .toISOString()
    .slice(0, 13)
    .replace(/[-T]/g, "")
  const ogUrl = `/api/og/order-flow?h=${hourStamp}`

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: PAGE_URL },
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: PAGE_URL,
      type: "article",
      images: [
        {
          url: ogUrl,
          width: 1200,
          height: 630,
          alt: "Live aggregated ZEC order-book depth, taker tape and price action",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [ogUrl],
    },
  }
}

export default function OrderFlowPage() {
  return <OrderFlowView />
}
