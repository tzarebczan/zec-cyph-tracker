"use client"

import { usePersistentState } from "@/lib/use-persistent-state"
import { EShell } from "@/components/shell"
import {
  BetaDashboard,
  PERIODS,
  isValidPeriod,
  type Period,
} from "@/components/dashboard"
import { ETabs } from "@/components/primitives"
import { SeoContent } from "@/components/seo-content"

// Home page = cypherpunk-terminal dashboard + indexable SEO prose
// rendered below. Period state is hoisted here so the period selector
// can live in EShell's `headerExtra` slot (right side of the CYPH/ZEC
// top row) instead of consuming its own strip below — BetaDashboard
// receives the value + setter as props rather than owning the
// persistence itself, so both halves stay in sync without a duplicate
// usePersistentState fighting for the same localStorage key.
//
// `SeoContent` is rendered inside EShell so it inherits the same
// max-w-6xl container + bottom-tab clearance the rest of the dashboard
// uses. GSC was the original reason this prose exists — the homepage
// earns the bulk of impressions and was thin on indexable text beyond
// the live numbers. Keeping it on / preserves that ranking signal.
export default function Home() {
  const [period, setPeriod] = usePersistentState<Period>(
    // Existing users' settings live under the `.beta.` key; we kept it
    // as-is during the beta→main promotion so nobody loses their saved
    // period / palette / ticker preferences. New users get the same
    // key; the "beta" segment is now purely historical.
    "cyphzec.beta.dashboard.days",
    "90",
    isValidPeriod
  )
  return (
    <EShell
      active="home"
      headerExtra={
        <ETabs items={PERIODS} active={period} onChange={setPeriod} />
      }
    >
      <BetaDashboard period={period} />
      <div className="mt-6">
        <SeoContent />
      </div>
    </EShell>
  )
}
