import kvIncrementalCache, {
  BINDING_NAME,
  NAME,
  PREFIX_ENV_NAME,
} from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache"
import { computeCacheKey } from "@opennextjs/cloudflare/overrides/internal"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  CacheEntryType,
  CacheValue,
  IncrementalCache,
  WithLastModified,
} from "@opennextjs/aws/types/overrides.js"

// OpenNext's KV cache put has no expiration. A fetch whose URL contains the
// current time is a new key on every call, and the previous key stays forever.
// That one namespace grew to ~490k keys and ~5 GB, and the writes are what
// the Workers KV bill charges past the included million. Give every entry a
// TTL so a deploy's cache and any fetch entry leave on their own.
// Pages are few (one per prerendered route per build) and a day is enough
// for them to be rewritten. Fetch bodies are the ones that multiplied.
const PAGE_TTL_SECONDS = 24 * 60 * 60
const FETCH_TTL_SECONDS = 60 * 60

type KvPut = {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>
}

function ttlFor(cacheType: CacheEntryType | undefined): number {
  return cacheType === "fetch" ? FETCH_TTL_SECONDS : PAGE_TTL_SECONDS
}

const cache: IncrementalCache = {
  name: NAME,
  get: kvIncrementalCache.get.bind(kvIncrementalCache) as IncrementalCache["get"],
  delete: kvIncrementalCache.delete.bind(kvIncrementalCache),
  async set<CacheType extends CacheEntryType = "cache">(
    key: string,
    value: CacheValue<CacheType>,
    cacheType?: CacheType
  ): Promise<void> {
    try {
      const { env } = getCloudflareContext() as unknown as {
        env: Record<string, KvPut | string | undefined>
      }
      const kv = env[BINDING_NAME]
      if (!kv || typeof kv === "string") return
      const prefix = env[PREFIX_ENV_NAME]
      const stored = computeCacheKey(key, {
        prefix: typeof prefix === "string" ? prefix : undefined,
        buildId: process.env.OPEN_NEXT_BUILD_ID,
        cacheType,
      })
      const entry: WithLastModified<CacheValue<CacheType>> = {
        value,
        // Date.now() in a Worker is the time of the last I/O, same as the
        // stock cache. Next uses it to decide when the entry is stale.
        lastModified: Date.now(),
      }
      await kv.put(stored, JSON.stringify(entry), {
        expirationTtl: ttlFor(cacheType),
      })
    } catch {
      // A missed cache write costs a re-render, not the response.
    }
  },
}

export default cache
