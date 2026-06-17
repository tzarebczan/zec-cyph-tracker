import { E_STATIC, paletteVar } from "./theme"

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
    summary: "ZEC venue share and 24h volume distribution.",
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
