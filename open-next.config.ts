import { defineCloudflareConfig } from "@opennextjs/cloudflare"
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue"
import kvIncrementalCache from "./lib/open-next-kv-cache"

// Without an incremental cache OpenNext uses a no-op ("dummy") store, so
// every prerendered page and every RSC prefetch payload was re-rendered on
// each request (`x-nextjs-cache: MISS` everywhere, ~40–70 ms of Worker time
// warm, 250–600 ms on a cold isolate). The KV store keeps the build's
// prerendered output and ISR revalidations, and the Next server answers from
// it (`x-nextjs-cache: HIT`). The dashboard itself is `force-dynamic` and
// unaffected; this is for every other route and for the per-segment
// prefetches the nav fires.
//
// `enableCacheInterception` is deliberately off. It answers a cache hit
// before the Next server runs, but that response is only the cached body plus
// the headers stored with it, and Next 16.2's router requires the
// `x-nextjs-deployment-id` header on every RSC response (the build id is no
// longer embedded in the payload). Without it the router assumes a different
// build is live and turns the client navigation into a full page load, so
// every bottom-tab tap reloaded the whole shell (measured 2026-09-24). The
// ~20 ms saved per hit is not worth that. Revisit if OpenNext starts
// forwarding the header (opennextjs-aws cacheInterceptor does not as of 4.1.5).
//
// The KV cache sets an expiration on every put (lib/open-next-kv-cache.ts).
// The stock adapter does not, so each distinct fetch URL was a permanent
// key. Fetch entries expire after an hour and page entries after a day.
//
// The memory queue handles ISR revalidation by HEAD-requesting the stale
// page through the WORKER_SELF_REFERENCE service binding (wrangler.jsonc),
// de-duplicated per isolate only. At this site's traffic that means at worst
// a handful of extra renders per hour; the Durable Object queue would need a
// migration, which the preview deploy on pull requests cannot apply.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: memoryQueue,
})
