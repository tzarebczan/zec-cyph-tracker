import { E_STATIC, paletteVar } from "./theme"

export type UpdateBadge = "BETA" | "NEW" | "IMPROVED"

export interface FeatureUpdate {
  id: string
  title: string
  date: string
  badge: UpdateBadge
  href: string
  summary: string
  details: string[]
  color: () => string
}

export const UPDATE_SEEN_KEY = "cyphzec.updates.seen.v1"

export const FEATURE_UPDATES: FeatureUpdate[] = [
  {
    id: "post-unshield-trace-beta-2026-06-11",
    title: "Post-unshield trace",
    date: "2026-06-11",
    badge: "BETA",
    href: "/shielding/unshieldings",
    summary: "Track deshielded ZEC after it lands on t-addresses.",
    details: [
      "1H, 12H, 1D, 1W, 1M, ALL windows.",
      "Held, spent, reused, return?, unknown labels.",
      "Cursor paging with conservative sale wording.",
    ],
    color: () => E_STATIC.red,
  },
]

export const LATEST_UPDATE_ID = FEATURE_UPDATES[0]?.id ?? ""

export function updateBadgeColor(update: FeatureUpdate) {
  if (update.badge === "BETA") return update.color()
  if (update.badge === "IMPROVED") return paletteVar("ratio")
  return paletteVar("cyph")
}
