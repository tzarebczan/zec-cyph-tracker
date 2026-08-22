// The /stats navigation model: four top-level sections, each with its own
// sub-view strip.
//
// Its own module rather than an export from `stats.tsx` for two reasons:
//   • link builders (the dashboard jump chips, Settings, the updates feed)
//     can name a view without importing the whole stats component tree —
//     `updates-data.ts` in particular is a plain data module and must stay
//     free of "use client" imports;
//   • the ids, their labels, their section, and the deep-link allow-list were
//     separate hand-maintained lists that had to agree. Everything below
//     derives from one array, so adding, moving or renaming a view is a
//     single edit that fails to compile if anything is left behind.
//
// ---------------------------------------------------------------------------
// Why two levels
// ---------------------------------------------------------------------------
// A single strip of seven sub-tabs overflowed its row on a phone — the last
// two were only reachable by horizontal scroll, with no affordance saying so.
// Order flow and the shielded views are the ones that carry their own detail,
// so they are promoted to sections; what is left under ZEC is four short
// labels that fit. No section needs more than four.
//
// ---------------------------------------------------------------------------
// The URL contract
// ---------------------------------------------------------------------------
// `?view=` names a LEAF view, never a section — the section is derived from
// the leaf. That keeps every link that predates the split working (and landing
// on the right section) without a redirect table: `?view=shieldedChart` still
// opens the chart, now under SHIELDED. Section ids are internal only, which is
// also why they don't collide with the leaf ids that shipped in URLs.

export const ZEC_SECTIONS = ["rankings", "zec", "pools", "flow"] as const
export type ZecSection = (typeof ZEC_SECTIONS)[number]

export const ZEC_SECTION_LABELS: Record<ZecSection, string> = {
  rankings: "RANKINGS",
  zec: "ZEC",
  pools: "SHIELDED",
  flow: "ORDER FLOW",
}

/** Every leaf view, in the order its section's strip renders them.
 *  Leaf ids are the public `?view=` contract — renaming one breaks links. */
export const ZEC_VIEWS = [
  { id: "supply", section: "zec", label: "SUPPLY" },
  { id: "rainbow", section: "zec", label: "RAINBOW" },
  // `short` is used below the md breakpoint. Only needed where the full label
  // would push its strip past a phone's width — "TX" matches the vocabulary
  // the ZEC tile and Ironwood banner already use ("DAILY TX", "MIGRATION TX").
  { id: "transactions", section: "zec", label: "TRANSACTIONS", short: "TX" },
  { id: "exchanges", section: "zec", label: "EXCHANGES" },
  { id: "shieldedOverview", section: "pools", label: "OVERVIEW" },
  { id: "shielded", section: "pools", label: "STATS" },
  { id: "shieldedChart", section: "pools", label: "CHART" },
  { id: "orderflow", section: "flow", label: "ORDER FLOW" },
] as const satisfies readonly {
  id: string
  section: ZecSection
  label: string
  short?: string
}[]

export type ZecView = (typeof ZEC_VIEWS)[number]["id"]

const VIEW_BY_ID = new Map<string, (typeof ZEC_VIEWS)[number]>(
  ZEC_VIEWS.map((v) => [v.id, v])
)

export function isZecView(v: unknown): v is ZecView {
  return typeof v === "string" && VIEW_BY_ID.has(v)
}

/** Which section a leaf view lives under. */
export function viewSection(view: ZecView): ZecSection {
  return VIEW_BY_ID.get(view)!.section
}

/** Strip label for a view. `compact` picks the short form where one exists. */
export function viewLabel(view: ZecView, compact = false): string {
  const v = VIEW_BY_ID.get(view)!
  return (compact && "short" in v ? v.short : v.label) as string
}

/** The leaf views under a section, in strip order. Empty for RANKINGS, which
 *  is a single page with no sub-strip; a section with one leaf renders no
 *  strip either, since a lone tab is just a label. */
export function sectionViews(
  section: ZecSection
): readonly (typeof ZEC_VIEWS)[number][] {
  return ZEC_VIEWS.filter((v) => v.section === section)
}

/** What a section opens on when you tab into it. */
export const SECTION_DEFAULT_VIEW: Record<ZecSection, ZecView | null> = {
  rankings: null,
  zec: "supply",
  pools: "shieldedOverview",
  flow: "orderflow",
}

/** The aggregated order-flow view. Typed as `ZecView`, so renaming the id in
 *  `ZEC_VIEWS` breaks the build here rather than silently leaving links
 *  pointing at a view `stats.tsx` no longer recognises (it ignores unknown
 *  `?view=` values and falls back to the default section). */
export const DEPTH_STATS_VIEW: ZecView = "orderflow"
