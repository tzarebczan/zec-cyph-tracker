import { EShell } from "@/components/shell"
import { BetaEstimator } from "@/components/estimator"

export default function EstimatorPage() {
  return (
    <EShell active="est">
      <BetaEstimator />
    </EShell>
  )
}
