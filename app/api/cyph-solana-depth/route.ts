import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getCyphSolanaDepth } from "@/lib/cyph-solana-depth"
import type { CyphSolanaDepthResponse } from "@/components/api-types"

export const dynamic = "force-dynamic"

/** Matches the module's own fresh window, so the edge never holds a book
 *  longer than the probe behind it considers current. */
const EDGE_TTL_SECONDS = 45

async function getWaitUntil(): Promise<
  ((p: Promise<unknown>) => void) | undefined
> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    const exec = ctx?.ctx
    return exec ? (p) => exec.waitUntil(p) : undefined
  } catch {
    return undefined
  }
}

/** Depth of the Solana CYPH pools, probed through Jupiter.
 *
 *  Unlike /api/cyph-depth (T+1 licensed Nasdaq depth) and /api/cyph-live-book
 *  (the bridge's live Nasdaq book), this one is current at every hour — the
 *  pools never close. The client only surfaces it while no US venue is
 *  trading, which is when it is the only CYPH market there is. */
export async function GET() {
  const book = await getCyphSolanaDepth(await getWaitUntil())
  if (!book) {
    return NextResponse.json(
      { error: "CYPH Solana depth unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
  const body: CyphSolanaDepthResponse = { fetchedAt: Date.now(), book }
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
    },
  })
}
