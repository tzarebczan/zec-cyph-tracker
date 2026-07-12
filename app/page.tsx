"use client"

import { usePersistentState } from "@/lib/use-persistent-state"
import { HeaderExtra } from "@/components/shell"
import {
  Dashboard,
  PERIODS,
  isValidPeriod,
  type Period,
} from "@/components/dashboard"
import { ETabs } from "@/components/primitives"

// Home page = cypherpunk-terminal dashboard. Period state is hoisted
// here so the period selector can live in EShell's `headerExtra` slot
// (right side of the CYPH/ZEC top row) instead of consuming its own
// strip below — Dashboard receives the value + setter as props rather
// than owning the persistence itself, so both halves stay in sync
// without a duplicate usePersistentState fighting for the same
// localStorage key.
//
// The dashboard used to be followed by a long-form `SeoContent` prose
// block ("About the CYPH / ZEC Ratio" + FAQ-style sections) for Google
// indexability, but it visually clashed with the cypherpunk-terminal
// aesthetic and the user opted to drop it. /about + the in-page FAQ
// keep substantive copy in front of crawlers; the small SEO downside
// is an accepted trade-off. The component file itself was also
// deleted since nothing imports it anymore.
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
    <>
      <HeaderExtra>
        <ETabs items={PERIODS} active={period} onChange={setPeriod} />
      </HeaderExtra>
      <Dashboard period={period} />
    </>
  )
}
