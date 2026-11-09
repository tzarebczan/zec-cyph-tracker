// Sharded, size-guarded KV storage for the per-pool trace map and flow
// inventory.
//
// Each used to be one KV value per pool. Workers KV caps a value at 25 MiB,
// and by Nov 2026 the Ironwood and Orchard trace blobs had reached ~26.21 MB.
// Every put past the cap failed, and the failure was swallowed
// (`saveTraceBlob(...).catch(() => {})`), so each run classified a batch in
// memory and threw it away: the stored blobs stopped changing on Sep 11
// (Ironwood) and Jul 30 (Orchard) while progress sat at "blob + one batch".
//
// Now each store is a manifest plus N shard values keyed by a hash of the
// entry id:
//
// - Shards are membership sets, so adding an entry changes one shard and a
//   run rewrites only the shards it touched.
// - N adapts to size. A save that would leave any shard over
//   SHARD_LIMITS.targetShardBytes re-shards to the next power of two that fits, so the
//   count never needs hand-tuning. Shard keys embed N, so a re-shard writes a
//   complete new set before the manifest switches to it; readers never see a
//   mix of two layouts.
// - Every put goes through `guardedPut`, which refuses values over
//   SHARD_LIMITS.maxValueBytes (well under KV's cap) with an error that names the key
//   and size. Errors propagate to the scheduler, which records the job as
//   failed, so a size problem can no longer hide behind ok:true.
// - The manifest records per-shard sizes, entry count and save time, which
//   /api/scheduler reports as storage health.
//
// Migration is read-through: until a pool's manifest exists, loads use the
// legacy single value and the first save writes every shard, then the
// manifest. After that a missing shard is an error, never an empty shard, so a
// run cannot overwrite real data with a partial view. Legacy values are left
// in place so a rollback to the previous build still has its data.

import {
  flowIdentity,
  inventoryKey,
  parseInventory,
  parseTraceBlob,
  traceBlobKey,
  type CachedTrace,
  type FlowInventory,
  type KVLike,
  type PoolMode,
} from "./shared"
import type { CipherscanFlow } from "./cipherscan"

export const MIN_SHARDS = 16
export const MAX_SHARDS = 1024
export const SHARD_LIMITS = {
  /** Re-shard when any shard would exceed this. */
  targetShardBytes: 8 * 1024 * 1024,
  /** Hard refusal threshold for any single KV value (KV's cap is 25 MiB). */
  maxValueBytes: 20 * 1024 * 1024,
}

export type ShardedPool = Exclude<PoolMode, "all">
type StoreKind = "traces" | "inventory"

const PREFIX: Record<StoreKind, string> = {
  traces: "zec.unshieldings.traces.v3",
  inventory: "zec.unshieldings.inventory.v3",
}

export function manifestKey(kind: StoreKind, pool: ShardedPool) {
  return `${PREFIX[kind]}.${pool}.manifest`
}
export function shardKey(
  kind: StoreKind,
  pool: ShardedPool,
  shards: number,
  index: number
) {
  return `${PREFIX[kind]}.${pool}.n${shards}.${index}`
}

const encoder = new TextEncoder()
export function byteLength(value: string): number {
  return encoder.encode(value).length
}

/** The only way this module writes KV. Returns the byte size written. */
export async function guardedPut(
  kv: KVLike,
  key: string,
  value: string,
  options?: { expirationTtl?: number }
): Promise<number> {
  const bytes = byteLength(value)
  if (bytes > SHARD_LIMITS.maxValueBytes) {
    throw new Error(
      `refusing KV put ${key}: ${bytes} bytes exceeds the ${SHARD_LIMITS.maxValueBytes}-byte guard`
    )
  }
  await kv.put(key, value, options)
  return bytes
}

/** FNV-1a with an fmix32 finaliser (plain FNV-1a has weak low bits, and a
 *  power-of-two modulus reads only those). Changing it needs a new prefix. */
export function shardIndex(id: string, shards: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % shards
}

export interface Manifest<M = undefined> {
  version: 3
  shards: number
  /** Byte size of each shard as last written. */
  sizes: number[]
  entries: number
  savedAt: number
  meta?: M
}

function parseManifest<M>(raw: string | null): Manifest<M> | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as Manifest<M>
  if (
    parsed?.version !== 3 ||
    !Number.isInteger(parsed.shards) ||
    !Array.isArray(parsed.sizes)
  ) {
    throw new Error("unreadable shard manifest")
  }
  return parsed
}

type Loaded<V, M> = { entries: Map<string, V>; manifest: Manifest<M> }

/** Shards hold `{ entries: Record<id, V> }`, or `{ items: V[] }` when the id
 *  is derivable from the value (`idOf`), which saves repeating the id. */
async function loadSharded<V, M>(
  kv: KVLike,
  kind: StoreKind,
  pool: ShardedPool,
  idOf?: (value: V) => string
): Promise<Loaded<V, M> | null> {
  // Not caught: a failed manifest read must not be mistaken for "not
  // migrated", which would rewrite every shard from the stale legacy value.
  const manifest = parseManifest<M>(await kv.get(manifestKey(kind, pool)))
  if (!manifest) return null
  const raws = await Promise.all(
    Array.from({ length: manifest.shards }, (_, i) =>
      kv.get(shardKey(kind, pool, manifest.shards, i))
    )
  )
  const entries = new Map<string, V>()
  raws.forEach((raw, i) => {
    if (raw == null) throw new Error(`${kind} shard ${i}/${manifest.shards} missing`)
    const parsed = JSON.parse(raw) as { entries?: Record<string, V>; items?: V[] }
    if (idOf && parsed.items) {
      for (const value of parsed.items) entries.set(idOf(value), value)
    } else {
      for (const [id, value] of Object.entries(parsed.entries ?? {})) {
        entries.set(id, value)
      }
    }
  })
  return { entries, manifest }
}

function serializeShards<V>(
  entries: Map<string, V>,
  shards: number,
  only: Set<number> | null,
  asItems: boolean
): Map<number, string> {
  const buckets = new Map<number, [string, V][]>()
  const wanted = only ?? new Set(Array.from({ length: shards }, (_, i) => i))
  for (const i of wanted) buckets.set(i, [])
  for (const [id, value] of entries) {
    buckets.get(shardIndex(id, shards))?.push([id, value])
  }
  const out = new Map<number, string>()
  for (const [i, bucket] of buckets) {
    out.set(
      i,
      JSON.stringify(
        asItems
          ? { items: bucket.map(([, v]) => v) }
          : { entries: Object.fromEntries(bucket) }
      )
    )
  }
  return out
}

const oversize = (serialized: Map<number, string>) =>
  [...serialized.values()].some((s) => byteLength(s) > SHARD_LIMITS.targetShardBytes)

/**
 * Persist `entries`. With a previous manifest and a dirty set, rewrites only
 * the dirty shards; otherwise (first write, or a dirty shard outgrew the
 * target) writes a complete layout at the smallest power-of-two count whose
 * shards all fit, then switches the manifest to it. Errors propagate.
 */
async function saveSharded<V, M>(
  kv: KVLike,
  kind: StoreKind,
  pool: ShardedPool,
  entries: Map<string, V>,
  previous: Manifest<M> | null,
  dirty: Set<string> | "all",
  meta?: M,
  asItems = false
): Promise<Manifest<M>> {
  let shards = previous?.shards ?? MIN_SHARDS
  let sizes = previous?.sizes.slice() ?? []
  let serialized: Map<number, string> | null = null
  let full = previous == null || dirty === "all"

  if (!full) {
    const indices = new Set([...(dirty as Set<string>)].map((id) => shardIndex(id, shards)))
    serialized = serializeShards(entries, shards, indices, asItems)
    if (oversize(serialized)) full = true
  }
  if (full) {
    for (;;) {
      serialized = serializeShards(entries, shards, null, asItems)
      if (!oversize(serialized) || shards >= MAX_SHARDS) break
      shards *= 2
    }
    sizes = new Array(shards).fill(0)
  }

  const written = await Promise.all(
    [...serialized!].map(async ([i, value]) => {
      const bytes = await guardedPut(kv, shardKey(kind, pool, shards, i), value)
      return [i, bytes] as const
    })
  )
  for (const [i, bytes] of written) sizes[i] = bytes

  const manifest: Manifest<M> = {
    version: 3,
    shards,
    sizes,
    entries: entries.size,
    savedAt: Date.now(),
    ...(meta !== undefined ? { meta } : {}),
  }
  await guardedPut(kv, manifestKey(kind, pool), JSON.stringify(manifest))

  // A re-shard leaves the old layout unreferenced. Best-effort cleanup.
  if (previous && previous.shards !== shards) {
    await Promise.all(
      Array.from({ length: previous.shards }, (_, i) =>
        kv.delete(shardKey(kind, pool, previous.shards, i)).catch(() => {})
      )
    )
  }
  return manifest
}

// ---------------------------------------------------------------- traces

export type LoadedTraces = {
  traces: Map<string, CachedTrace>
  manifest: Manifest | null
}

export async function loadTraces(
  kv: KVLike,
  pool: ShardedPool
): Promise<LoadedTraces> {
  const loaded = await loadSharded<CachedTrace, undefined>(kv, "traces", pool)
  if (loaded) return { traces: loaded.entries, manifest: loaded.manifest }
  return { traces: parseTraceBlob(await kv.get(traceBlobKey(pool))), manifest: null }
}

/** Saves and updates `loaded.manifest`, so later saves in the run are partial. */
export async function saveTraces(
  kv: KVLike,
  pool: ShardedPool,
  loaded: LoadedTraces,
  dirty: Set<string> | "all"
): Promise<Manifest> {
  loaded.manifest = await saveSharded(kv, "traces", pool, loaded.traces, loaded.manifest, dirty)
  return loaded.manifest
}

// ------------------------------------------------------------- inventory

type InventoryMeta = Omit<FlowInventory, "flows">

export type LoadedInventory = {
  inventory: FlowInventory | null
  manifest: Manifest<InventoryMeta> | null
}

const byBlockTimeDesc = (a: CipherscanFlow, b: CipherscanFlow) =>
  (b.blockTime ?? 0) - (a.blockTime ?? 0)

export async function loadInventoryStore(
  kv: KVLike,
  pool: ShardedPool
): Promise<LoadedInventory> {
  const loaded = await loadSharded<CipherscanFlow, InventoryMeta>(
    kv,
    "inventory",
    pool,
    flowIdentity
  )
  if (loaded) {
    const flows = [...loaded.entries.values()].sort(byBlockTimeDesc)
    return {
      inventory: { ...(loaded.manifest.meta as InventoryMeta), flows },
      manifest: loaded.manifest,
    }
  }
  return { inventory: parseInventory(await kv.get(inventoryKey(pool))), manifest: null }
}

/** Ids whose membership differs. Flows are never edited in place (refreshes
 *  only add or drop identities), so membership is the whole diff. */
export function changedInventoryIds(
  before: FlowInventory | null,
  after: FlowInventory
): Set<string> {
  const prev = new Set((before?.flows ?? []).map(flowIdentity))
  const next = new Set(after.flows.map(flowIdentity))
  const changed = new Set<string>()
  for (const id of next) if (!prev.has(id)) changed.add(id)
  for (const id of prev) if (!next.has(id)) changed.add(id)
  return changed
}

/** Writes changed shards and always the manifest, which carries
 *  fetchedAt/headFetchedAt (they gate the next refresh). Errors propagate. */
export async function saveInventoryStore(
  kv: KVLike,
  pool: ShardedPool,
  inventory: FlowInventory,
  loaded: LoadedInventory
): Promise<Manifest<InventoryMeta>> {
  const { flows, ...meta } = inventory
  const entries = new Map(flows.map((flow) => [flowIdentity(flow), flow]))
  const dirty = loaded.manifest ? changedInventoryIds(loaded.inventory, inventory) : "all"
  const manifest = await saveSharded(
    kv,
    "inventory",
    pool,
    entries,
    loaded.manifest,
    dirty,
    meta,
    true
  )
  loaded.manifest = manifest
  loaded.inventory = inventory
  return manifest
}

// ---------------------------------------------------------------- health

export type StoreHealth =
  | { migrated: false }
  | {
      migrated: true
      shards: number
      entries: number
      savedAt: number
      largestShardBytes: number
      totalBytes: number
    }

export async function readStorageHealth(
  kv: { get(k: string): Promise<string | null> },
  pool: ShardedPool
): Promise<Record<StoreKind, StoreHealth>> {
  const read = async (kind: StoreKind): Promise<StoreHealth> => {
    const manifest = parseManifest(await kv.get(manifestKey(kind, pool)))
    if (!manifest) return { migrated: false }
    return {
      migrated: true,
      shards: manifest.shards,
      entries: manifest.entries,
      savedAt: manifest.savedAt,
      largestShardBytes: Math.max(0, ...manifest.sizes),
      totalBytes: manifest.sizes.reduce((a, b) => a + b, 0),
    }
  }
  const [traces, inventory] = await Promise.all([read("traces"), read("inventory")])
  return { traces, inventory }
}
