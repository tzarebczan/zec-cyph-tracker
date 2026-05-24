import { EShell } from "@/components/shell"
import { BetaStats } from "@/components/stats"

export default function StatsPage() {
  return (
    <EShell active="rank">
      <BetaStats />
    </EShell>
  )
}
