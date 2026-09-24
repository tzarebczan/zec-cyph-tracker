import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { KVLike } from "@/lib/unshieldings/shared"
import { GET as getQuote } from "@/app/api/quote/route"
import { GET as getPrices } from "@/app/api/prices/route"
import { GET as getMarkets } from "@/app/api/markets/route"
import { GET as getZecStats } from "@/app/api/zec-stats/route"
import { GET as getHoldings } from "@/app/api/cypherpunk-holdings/route"
import { GET as getMnav } from "@/app/api/cypherpunk-mnav/route"
import { GET as getCyphVolume } from "@/app/api/cyph-volume/route"
import { GET as getIronwood } from "@/app/api/ironwood/route"
import { GET as getShieldingDetails } from "@/app/api/shielding-details/route"
import { GET as getTicker } from "@/app/api/ticker/route"

/**
 * Server-side bootstrap for the dashboard.
 *
 * The home page used to ship as a static shell of skeletons; the numbers
 * arrived only after the JavaScript loaded, React hydrated, and fourteen
 * `/api/*` requests went out together. Measured on a throttled phone that
 * put the largest text on the page at 2.7–4.1 s, and the fan-out itself
 * cost 0.6–1.3 s because the Worker serializes a fixed per-request cost on
 * one connection.
 *
 * This runs the same route handlers in the page render, so the HTML carries
 * the headline data and the first paint is the real dashboard. Each SWR key
 * the dashboard subscribes to on mount is paired with the handler that
 * serves it, and the result is handed to `SWRConfig.fallback`; SWR still
 * revalidates on mount, so nothing about freshness changes, only what the
 * user sees while that happens.
 *
 * Every source is optional. A handler that misses the budget, throws, or
 * returns an error is left out and the client fetches it as before, so the
 * bootstrap can only ever make the first paint better, never block it for
 * long. The budget is the point where a slow upstream would cost more TTFB
 * than the client round trip it saves.
 */

const ORIGIN = "https://cyphzec.com"

/** Per-request ceiling on how long the render waits for any one source. */
export const BOOTSTRAP_BUDGET_MS = 250

/** KV kill switch: `{"dashboardBootstrap": false}` under this key disables the
 *  bootstrap without a deploy. Read in parallel with the sources, so it costs
 *  no latency on the normal path. */
export const FLAGS_KV_KEY = "cyphzec.flags.v1"

type Source = { key: string; load: () => Promise<Response> }

const jsonRequest = (path: string) =>
  new Request(ORIGIN + path, { headers: { accept: "application/json" } })

/** Keys are the exact SWR keys used by the dashboard, the Ironwood banner
 *  and the ticker, in the order they matter for the first paint. */
const SOURCES: readonly Source[] = [
  { key: "/api/quote", load: () => getQuote(jsonRequest("/api/quote")) },
  { key: "/api/prices?days=7", load: () => getPrices(jsonRequest("/api/prices?days=7")) },
  { key: "/api/prices?days=90", load: () => getPrices(jsonRequest("/api/prices?days=90")) },
  { key: "/api/ironwood", load: () => getIronwood() },
  {
    key: "/api/shielding-details?pool=all&summary",
    load: () => getShieldingDetails(jsonRequest("/api/shielding-details?pool=all&summary")),
  },
  { key: "/api/zec-stats", load: () => getZecStats() },
  { key: "/api/markets", load: () => getMarkets() },
  { key: "/api/cypherpunk-holdings", load: () => getHoldings() },
  { key: "/api/cypherpunk-mnav", load: () => getMnav() },
  { key: "/api/cyph-volume", load: () => getCyphVolume() },
  { key: "/api/ticker", load: () => getTicker() },
]

const TIMEOUT = Symbol("bootstrap-timeout")

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function loadSource(
  source: Source,
  deadline: Promise<typeof TIMEOUT>
): Promise<[string, unknown] | null> {
  try {
    const res = await Promise.race([source.load(), deadline])
    if (res === TIMEOUT || !res.ok) return null
    const json: unknown = await Promise.race([res.json(), deadline])
    if (json === TIMEOUT || json == null) return null
    // Mirrors swrFetcher: a 200 with an `error` field is a miss, not data.
    if (typeof json === "object" && "error" in (json as Record<string, unknown>)) return null
    return [source.key, json]
  } catch {
    return null
  }
}

async function bootstrapEnabled(): Promise<boolean> {
  try {
    const { env } = await getCloudflareContext({ async: true })
    const kv = (env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE
    if (!kv) return true
    const raw = await Promise.race([kv.get(FLAGS_KV_KEY), after(BOOTSTRAP_BUDGET_MS, null)])
    if (!raw) return true
    const flags = JSON.parse(raw) as { dashboardBootstrap?: unknown }
    return flags.dashboardBootstrap !== false
  } catch {
    return true
  }
}

/** Fallback data for `SWRConfig`, keyed by SWR key. Empty when disabled or
 *  when nothing answered in time. */
export async function getDashboardBootstrap(): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const deadline = after(BOOTSTRAP_BUDGET_MS, TIMEOUT)
  const [enabled, entries] = await Promise.all([
    bootstrapEnabled(),
    Promise.all(SOURCES.map((source) => loadSource(source, deadline))),
  ])
  if (!enabled) return {}
  const found = entries.filter((e): e is [string, unknown] => e != null)
  if (found.length < SOURCES.length) {
    const missing = SOURCES.map((s) => s.key).filter((k) => !found.some(([key]) => key === k))
    console.log(
      `[bootstrap] ${found.length}/${SOURCES.length} sources in ${Date.now() - startedAt}ms; missing: ${missing.join(", ")}`
    )
  }
  return Object.fromEntries(found)
}
