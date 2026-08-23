import { E_STATIC, paletteVar } from "./theme"
import { DEPTH_STATS_VIEW } from "./zec-views"

export type UpdateBadge = "BETA" | "NEW" | "IMPROVED"

export interface FeatureUpdate {
  id: string
  title: string
  shippedAt: string
  updatedAt: string
  badge: UpdateBadge
  href: string
  summary: string
  details: string[]
  color: () => string
}

export const UPDATE_SEEN_KEY = "cyphzec.updates.seen.v1"

export const FEATURE_UPDATES: FeatureUpdate[] = [
  {
    id: "cyph-order-book-2026-08-23",
    title: "CYPH order book",
    shippedAt: "2026-08-23",
    updatedAt: "2026-08-23",
    badge: "NEW",
    // ?view=book so the link opens the card it advertises. On mobile the
    // treasury groups its cards into tabs, and a bare /holdings would land a
    // reader on whichever group they last left selected.
    href: "/holdings?view=book",
    summary: "Ten-level CYPH depth for every session, overnight included.",
    details: [
      "Last session's book across overnight, pre-market, regular and after-hours.",
      "Near-live tape by price, plus a session countdown on the CYPH tile.",
    ],
    color: () => paletteVar("cyph"),
  },
  {
    id: "order-flow-depth-2026-08-22",
    title: "Aggregated order flow",
    shippedAt: "2026-08-22",
    updatedAt: "2026-08-22",
    badge: "NEW",
    href: `/stats?view=${DEPTH_STATS_VIEW}`,
    summary: "Live bids-vs-asks depth across seven exchange books.",
    details: [
      "Seven books in one curve, with liquidity ladder, walls and impact to $5M.",
      "Taker tape, delta, large prints. Settings → ORDER DEPTH.",
    ],
    color: () => paletteVar("cyph"),
  },
  {
    id: "ironwood-live-tracker-2026-07-27",
    title: "Ironwood live tracker",
    shippedAt: "2026-07-27",
    updatedAt: "2026-07-27",
    badge: "NEW",
    href: "/ironwood",
    summary: "NU6.3 activation countdown that flips into a migration dashboard.",
    details: [
      "Live countdown with blocks remaining and estimated activation in your zone.",
      "Block rail, mempool and tx feed; flow and supply views at activation.",
    ],
    color: () => paletteVar("amber"),
  },
  {
    id: "zec-rainbow-model-2026-07-10",
    title: "ZEC adaptive rainbow",
    shippedAt: "2026-07-10",
    updatedAt: "2026-07-10",
    badge: "NEW",
    href: "/stats?view=rainbow#rainbow",
    summary: "Explore ZEC price regimes with an adaptive long-range trend.",
    details: [
      "180-day log trend with four-year volatility-calibrated bands.",
      "Switch between BTC and ZEC rainbow views on Bitcoin / ZEC analytics.",
    ],
    color: () => paletteVar("zec"),
  },
  {
    id: "bitcoin-zec-analytics-2026-07-10",
    title: "Bitcoin / ZEC analytics",
    shippedAt: "2026-07-10",
    updatedAt: "2026-07-10",
    badge: "NEW",
    href: "/bitcoin",
    summary: "Compare Bitcoin and ZEC with live pair context and long-range market signals.",
    details: [
      "Live BTC, ZEC, market-cap, supply, ratio, and sats-per-ZEC stats.",
      "Relative performance across 7D, 30D, 90D, and all available history.",
      "BTC / ZEC rainbow selector and clearer relative-performance comparisons.",
    ],
    color: () => paletteVar("ratio"),
  },
  {
    id: "portfolio-performance-dashboard-2026-06-23",
    title: "Portfolio performance",
    shippedAt: "2026-06-23",
    updatedAt: "2026-06-23",
    badge: "NEW",
    href: "/portfolio",
    summary: "Track CYPH and ZEC holdings with live P/L and dashboard tiles.",
    details: [
      "Separate average cost basis for CYPH and ZEC.",
      "Daily, 1W, 1M, 3M, and 6M portfolio performance.",
      "Optional dashboard portfolio tile with reorderable dashboard tiles.",
    ],
    color: () => paletteVar("ratio"),
  },
  {
    id: "cyph-share-volume-delta-2026-06-17",
    title: "CYPH share volume",
    shippedAt: "2026-06-17",
    updatedAt: "2026-06-17",
    badge: "NEW",
    href: "/holdings",
    summary: "Shares traded now include a 7-day average comparison.",
    details: [
      "Dashboard CYPH tile shows volume vs 7-day average.",
      "Treasury page adds 24H, 1W, 7D average, and delta.",
    ],
    color: () => paletteVar("cyph"),
  },
  {
    id: "post-unshield-trace-reshield-beta-2026-06-11",
    title: "Post-unshield trace",
    shippedAt: "2026-06-11",
    updatedAt: "2026-06-11",
    badge: "BETA",
    href: "/shielding/unshieldings",
    summary: "Track deshielded ZEC after it lands on t-addresses.",
    details: [
      "Choose 1H, 12H, 1D, 1W, 1M, or ALL.",
      "Classifies held, reshielded, spent, reused, and unknown outcomes.",
    ],
    color: () => E_STATIC.red,
  },
  {
    id: "shielding-details-cipherscan-2026-06-05",
    title: "Shielding details",
    shippedAt: "2026-06-05",
    updatedAt: "2026-06-11",
    badge: "IMPROVED",
    href: "/shielding",
    summary: "Post-NU6.2 shielding flow by hour, day, and pool.",
    details: [
      "Orchard / all-pools toggle.",
      "Live CipherScan flow data with manual refresh.",
    ],
    color: () => paletteVar("ratio"),
  },
  {
    id: "treasury-target-circulating-2026-06-08",
    title: "Treasury",
    shippedAt: "2026-06-08",
    updatedAt: "2026-06-08",
    badge: "IMPROVED",
    href: "/holdings",
    summary: "Cypherpunk ZEC holdings with cleaner target math.",
    details: [
      "5% target uses circulating supply.",
      "Per-share card shows shares outstanding.",
    ],
    color: () => paletteVar("amber"),
  },
  {
    id: "orchard-risk-market-2026-06-05",
    title: "Orchard risk signal",
    shippedAt: "2026-06-05",
    updatedAt: "2026-06-05",
    badge: "NEW",
    href: "/orchard-risk",
    summary: "A compact Polymarket signal for Orchard exploit odds.",
    details: [
      "Dedicated page with market history.",
      "Share image for X posts.",
    ],
    color: () => E_STATIC.red,
  },
  {
    id: "exchange-stats-2026-06-02",
    title: "Exchange stats",
    shippedAt: "2026-06-02",
    updatedAt: "2026-06-03",
    badge: "NEW",
    href: "/exchanges",
    summary: "ZEC exchange share and 24h volume distribution.",
    details: [
      "Exchange, pair, and volume-share views.",
      "Share image support for the stats surface.",
    ],
    color: () => paletteVar("zec"),
  },
  {
    id: "what-if-scenarios-2026-05-24",
    title: "What-if scenarios",
    shippedAt: "2026-05-24",
    updatedAt: "2026-06-07",
    badge: "IMPROVED",
    href: "/what-if",
    summary: "ZEC market-capture scenarios with live basis toggles.",
    details: [
      "BTC price-basis toggle for comparisons.",
      "Gold, global economy, offshore wealth, and more.",
    ],
    color: () => paletteVar("cyph"),
  },
]

export const LATEST_UPDATE_ID = FEATURE_UPDATES[0]?.id ?? ""

export function updateBadgeColor(update: FeatureUpdate) {
  if (update.badge === "BETA") return update.color()
  if (update.badge === "IMPROVED") return paletteVar("ratio")
  return paletteVar("cyph")
}
