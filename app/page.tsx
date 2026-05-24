"use client"

import { usePersistentState } from "@/lib/use-persistent-state"
import { EShell } from "@/components/shell"
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
// SeoContent used to render below the dashboard for GSC indexable
// prose, but was dropped at the user's request — /about + the in-page
// FAQ already give crawlers substantive copy, and the prose block
// visually clashed with the cypherpunk-terminal aesthetic on the
// homepage.
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
      <Dashboard period={period} />
    </EShell>
  )
}
