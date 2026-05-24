import { EShell } from "@/components/shell"
import { BetaSettings } from "@/components/settings"

export default function SettingsPage() {
  return (
    <EShell active="settings">
      <BetaSettings />
    </EShell>
  )
}
