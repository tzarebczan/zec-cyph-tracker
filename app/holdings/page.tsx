import { EShell } from "@/components/shell"
import { Treasury } from "@/components/treasury"

export default function HoldingsPage() {
  return (
    <EShell active="trsy">
      <Treasury />
    </EShell>
  )
}
