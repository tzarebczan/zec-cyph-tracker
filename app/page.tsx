import { HomeClient } from "@/components/home-client"
import { getDashboardBootstrap } from "@/lib/dashboard-bootstrap"

// The dashboard renders per request so its HTML can carry the current
// numbers (see lib/dashboard-bootstrap.ts). It was a prerendered shell of
// skeletons before, but with the default OpenNext cache every request
// re-rendered that shell anyway, so this costs the Worker a few KV reads
// and saves the browser a hydrate-then-fetch round trip before the first
// real paint. The other routes stay static.
export const dynamic = "force-dynamic"

export default async function Home() {
  const bootstrap = await getDashboardBootstrap()
  return <HomeClient bootstrap={bootstrap} />
}
