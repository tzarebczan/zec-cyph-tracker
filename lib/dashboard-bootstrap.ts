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
 * Rendering with data means a few clock-dependent branches (session badge,
 * which session's print is live) are now evaluated on the server too. They
 * are pure functions of the quote and the current time, so the server and
 * the client agree except in the seconds around a session boundary; there
 * React recovers by re-rendering the client tree once, which is also what
 * happened before whenever any hydration mismatch occurred.
 *
 * Every source is optional. A handler that misses the budget, throws, or
 * returns an error is left out and the client fetches it as before, so the
 * bootstrap can only ever make the first paint better, never block it for
 * long. The budget is the point where a slow upstream would cost more TTFB
 * than the client round trip it saves.
 */

/** Per-request ceiling on how long the render waits for any one source. */
export const BOOTSTRAP_BUDGET_MS = 250

/** KV kill switch: `{"dashboardBootstrap": false}` under this key disables the
 *  bootstrap without a deploy. Read in parallel with the sources, so it costs
 *  no latency on the normal path. */
export const FLAGS_KV_KEY = "cyphzec.flags.v1"

type Source = { key: string; load: (origin: string) => Promise<Response> }

/** Handlers that read the URL get a request on the same origin the page was
 *  asked for, so a handler's own last-resort self-fetch (quote falls back to
 *  /api/prices) stays on this deployment instead of crossing to production
 *  from a preview or a local Worker. */
const jsonRequest = (origin: string, path: string) =>
  new Request(origin + path, { headers: { accept: "application/json" } })

/** Keys are the exact SWR keys the dashboard and the Ironwood banner use on
 *  mount, in the order they matter for the first paint. The shell's ticker
 *  hooks sit above the page's SWRConfig and cannot see this fallback, so
 *  its keys (/api/ticker) are deliberately not here. */
const SOURCES: readonly Source[] = [
  { key: "/api/quote", load: (o) => getQuote(jsonRequest(o, "/api/quote")) },
  { key: "/api/prices?days=7", load: (o) => getPrices(jsonRequest(o, "/api/prices?days=7")) },
  { key: "/api/prices?days=90", load: (o) => getPrices(jsonRequest(o, "/api/prices?days=90")) },
  { key: "/api/ironwood", load: () => getIronwood() },
  {
    key: "/api/shielding-details?pool=all&summary",
    load: (o) => getShieldingDetails(jsonRequest(o, "/api/shielding-details?pool=all&summary")),
  },
  { key: "/api/zec-stats", load: () => getZecStats() },
  { key: "/api/markets", load: () => getMarkets() },
  { key: "/api/cypherpunk-holdings", load: () => getHoldings() },
  { key: "/api/cypherpunk-mnav", load: () => getMnav() },
  { key: "/api/cyph-volume", load: () => getCyphVolume() },
]

const TIMEOUT = Symbol("bootstrap-timeout")

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

type Loaded = { key: string; json: unknown } | { key: string; miss: string }

const describeError = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : String(e).slice(0, 160)

async function loadSource(
  source: Source,
  origin: string,
  deadline: Promise<typeof TIMEOUT>
): Promise<Loaded> {
  const { key } = source
  try {
    // `Promise.race` does not cancel the loser. A handler that misses the
    // budget keeps running, and if it later rejects that would surface as
    // an unhandled rejection on the Worker, so every racer gets its own
    // sink before the race. The sinks keep the failure reason so the log
    // below can say why a source was left out.
    const load = source.load(origin).then(
      (res) => res,
      (e: unknown) => ({ miss: `rejected: ${describeError(e)}` })
    )
    const res = await Promise.race([load, deadline])
    if (res === TIMEOUT) return { key, miss: "timeout" }
    if (!(res instanceof Response)) return { key, miss: res.miss }
    if (!res.ok) return { key, miss: `status ${res.status}` }
    const parse = res.json().then(
      (json: unknown) => ({ json }),
      (e: unknown) => ({ miss: `parse: ${describeError(e)}` })
    )
    const parsed = await Promise.race([parse, deadline])
    if (parsed === TIMEOUT) return { key, miss: "timeout (body)" }
    if (!("json" in parsed)) return { key, miss: parsed.miss }
    const { json } = parsed
    if (json == null) return { key, miss: "empty body" }
    // Mirrors swrFetcher: a 200 with an `error` field is a miss, not data.
    if (typeof json === "object" && "error" in (json as Record<string, unknown>)) {
      return { key, miss: `error field: ${String((json as Record<string, unknown>).error).slice(0, 80)}` }
    }
    return { key, json }
  } catch (e) {
    return { key, miss: `threw: ${describeError(e)}` }
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

/** The origin the page was requested on, from the forwarded headers Next
 *  exposes. Falls back to production when a header is missing. */
export function originFromHeaders(h: { get(name: string): string | null }): string {
  const host = h.get("x-forwarded-host") ?? h.get("host")
  if (!host) return "https://cyphzec.com"
  const proto =
    h.get("x-forwarded-proto") ??
    (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https")
  return `${proto}://${host}`
}

/** Fallback data for `SWRConfig`, keyed by SWR key. Empty when disabled or
 *  when nothing answered in time. */
export async function getDashboardBootstrap(origin: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const deadline = after(BOOTSTRAP_BUDGET_MS, TIMEOUT)
  const [enabled, entries] = await Promise.all([
    bootstrapEnabled(),
    Promise.all(SOURCES.map((source) => loadSource(source, origin, deadline))),
  ])
  if (!enabled) return {}
  const found: Array<[string, unknown]> = []
  const missed: string[] = []
  for (const entry of entries) {
    if ("json" in entry) found.push([entry.key, entry.json])
    else missed.push(`${entry.key} (${entry.miss})`)
  }
  if (missed.length > 0) {
    console.log(
      `[bootstrap] ${found.length}/${SOURCES.length} sources in ${Date.now() - startedAt}ms; missing: ${missed.join("; ")}`
    )
  }
  return Object.fromEntries(found)
}
