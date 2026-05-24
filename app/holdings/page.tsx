import { EShell } from "@/components/shell"
import { BetaTreasury } from "@/components/treasury"

export default function HoldingsPage() {
  return (
    <EShell active="trsy">
      <BetaTreasury />
    </EShell>
  )
}
