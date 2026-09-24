import { defineCloudflareConfig } from "@opennextjs/cloudflare"
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache"
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue"

// Without an incremental cache OpenNext uses a no-op ("dummy") store, so
// every prerendered page and every RSC prefetch payload was re-rendered on
// each request (`x-nextjs-cache: MISS` everywhere, ~40–70 ms of Worker time
// warm, 250–600 ms on a cold isolate). The KV store keeps the build's
// prerendered output and ISR revalidations; cache interception then serves
// a hit without booting the Next server at all. The dashboard itself is
// `force-dynamic` and unaffected; this is for every other route and for the
// per-segment prefetches the nav fires.
//
// The memory queue runs ISR revalidation in-process via waitUntil. It does
// not dedupe across isolates, which at this site's traffic means at worst
// a handful of extra renders per hour; the Durable Object queue would need a
// migration, which the preview deploy on pull requests cannot apply.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: memoryQueue,
  enableCacheInterception: true,
})
