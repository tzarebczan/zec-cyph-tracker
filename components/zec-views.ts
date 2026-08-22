// ZEC sub-views on /stats.
//
// Its own module rather than an export from `stats.tsx` for two reasons:
//   • link builders (the dashboard jump chips, Settings, the updates feed)
//     can name a view without importing the whole stats component tree —
//     `updates-data.ts` in particular is a plain data module and must stay
//     free of "use client" imports;
//   • the ids, their labels, and the deep-link allow-list were three separate
//     hand-maintained lists inside `stats.tsx` that had to agree. Now the tab
//     strip, the `?view=` parser and the type all derive from this one array,
//     so adding or renaming a view is a single edit that fails to compile if
//     anything is left behind.

/** Every ZEC sub-view, in the order the tab strip renders them. */
export const ZEC_SUB_VIEWS = [
  "supply",
  "shielded",
  "rainbow",
  "shieldedChart",
  "transactions",
  "exchanges",
  "orderflow",
] as const

export type ZecSub = (typeof ZEC_SUB_VIEWS)[number]

export const ZEC_SUB_LABELS: Record<ZecSub, string> = {
  supply: "SUPPLY",
  shielded: "SHIELDED",
  rainbow: "RAINBOW",
  shieldedChart: "SHIELDED CHART",
  transactions: "TRANSACTIONS",
  exchanges: "EXCHANGES",
  orderflow: "ORDER FLOW",
}

/** The aggregated order-flow view. Typed as `ZecSub`, so renaming the id in
 *  `ZEC_SUB_VIEWS` breaks the build here rather than silently leaving links
 *  pointing at a view `stats.tsx` no longer recognises (it ignores unknown
 *  `?view=` values and falls back to SUPPLY). */
export const DEPTH_STATS_VIEW: ZecSub = "orderflow"

export function isZecSub(v: unknown): v is ZecSub {
  return typeof v === "string" && (ZEC_SUB_VIEWS as readonly string[]).includes(v)
}
