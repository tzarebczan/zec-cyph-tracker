"use client"

import { usePersistentState } from "@/lib/use-persistent-state"
import { EShell } from "@/components/beta/shell"
import {
  BetaDashboard,
  PERIODS,
  isValidPeriod,
  type Period,
} from "@/components/beta/dashboard"
import { ETabs } from "@/components/beta/primitives"

// Period state is hoisted to the page so the period selector can live
// in EShell's `headerExtra` slot (right side of the CYPH/ZEC top row)
// instead of consuming its own strip below. BetaDashboard receives the
// value + setter as props rather than owning the persistence itself,
// so both halves stay in sync without a duplicate usePersistentState
// fighting for the same localStorage key.
export default function BetaHomePage() {
  const [period, setPeriod] = usePersistentState<Period>(
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
    </EShell>
  )
}
