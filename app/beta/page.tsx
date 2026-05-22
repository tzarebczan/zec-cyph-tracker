import { EShell } from "@/components/beta/shell"
import { BetaDashboard } from "@/components/beta/dashboard"

export default function BetaHomePage() {
  return (
    <EShell active="home">
      <BetaDashboard />
    </EShell>
  )
}
