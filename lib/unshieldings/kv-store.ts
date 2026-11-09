// Sharded KV storage for the per-pool trace map and flow inventory.
//
// Each used to be one KV value per pool. Workers KV caps a value at 25 MiB
// (26,214,400 bytes), and by Nov 2026 the Ironwood and Orchard trace blobs had
// reached ~26.21 MB. Every put past the cap failed, and the failure was
// swallowed (`saveTraceBlob(...).catch(() => {})`), so each run classified a
// batch in memory and threw it away: the stored blobs stopped changing on
// Sep 11 (Ironwood) and Jul 30 (Orchard) while the progress count sat at
// "blob + one batch" forever. The Ironwood inventory was ~25.0 MB and about
// to hit the same wall.
//
// Both now live in SHARD_COUNT values keyed by a hash of the flow identity,
// so each value is ~1/16 of the old size and a run only rewrites the shards
// it touched. Hash sharding (rather than slicing the sorted list) keeps every
// shard a plain membership set: inserting a new flow changes one shard, not
// every slice boundary, and a reader that sees one shard newer than another
// sees a subset of flows, never a corrupted list.
//
// Migration is read-through. Until a pool's manifest/meta key exists, loads
// fall back to the legacy single value and the next save writes every shard,
// then the manifest. The manifest is written last, so a reader either sees the
// legacy value or a complete shard set. Once the manifest exists, a missing
// shard is an error, not an empty shard, so a run can never overwrite real
// data with a partial view. The legacy values are left in place (they still
// expire on their old TTL) so a rollback to the previous build still works.

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

export const SHARD_COUNT = 16

const TRACE_SHARD_PREFIX = "zec.unshieldings.traces.shard.v2"
const INVENTORY_SHARD_PREFIX = "zec.unshieldings.inventory.v2"

type ShardedPool = Exclude<PoolMode, "all">

export function traceShardKey(pool: ShardedPool, index: number) {
  return `${TRACE_SHARD_PREFIX}.${pool}.${index}`
}
export function traceManifestKey(pool: ShardedPool) {
  return `${TRACE_SHARD_PREFIX}.${pool}.manifest`
}
export function inventoryShardKey(pool: ShardedPool, index: number) {
  return `${INVENTORY_SHARD_PREFIX}.${pool}.${index}`
}
export function inventoryMetaKey(pool: ShardedPool) {
  return `${INVENTORY_SHARD_PREFIX}.${pool}.meta`
}

/** FNV-1a, 32-bit, with a final avalanche. Stable across isolates and deploys, which is all a shard
 *  key needs. Changing it (or SHARD_COUNT) needs a new key prefix. */
export function shardIndex(identity: string, count = SHARD_COUNT): number {
  let h = 0x811c9dc5
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // fmix32 finaliser: plain FNV-1a has weak low bits, and `% 16` only reads
  // the low four, which left one shard holding a third of the data in tests.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % count
}

const allShards = () => Array.from({ length: SHARD_COUNT }, (_, i) => i)

async function readAllShards(
  kv: KVLike,
  keyFor: (index: number) => string,
  what: string
): Promise<string[]> {
  const raws = await Promise.all(allShards().map((i) => kv.get(keyFor(i))))
  return raws.map((raw, i) => {
    if (raw == null) throw new Error(`${what} shard ${i} missing`)
    return raw
  })
}

// ---------------------------------------------------------------- traces

export type LoadedTraces = {
  traces: Map<string, CachedTrace>
  /** True when read from the legacy single blob; the next save writes all. */
  legacy: boolean
}

export async function loadTraces(
  kv: KVLike,
  pool: ShardedPool
): Promise<LoadedTraces> {
  // Deliberately not caught: treating a failed manifest read as "not
  // migrated" would rewrite the shards from the stale legacy blob.
  if (await kv.get(traceManifestKey(pool))) {
    const raws = await readAllShards(kv, (i) => traceShardKey(pool, i), "trace")
    const traces = new Map<string, CachedTrace>()
    for (const raw of raws) {
      for (const [id, cached] of parseTraceBlob(raw)) traces.set(id, cached)
    }
    return { traces, legacy: false }
  }
  const raw = await kv.get(traceBlobKey(pool))
  return { traces: parseTraceBlob(raw), legacy: true }
}

/** Write the shards holding `dirty` identities, or every shard plus the
 *  manifest when migrating off the legacy blob. Errors propagate. */
export async function saveTraces(
  kv: KVLike,
  pool: ShardedPool,
  traces: Map<string, CachedTrace>,
  dirty: Iterable<string> | "all"
): Promise<number> {
  const indices =
    dirty === "all"
      ? new Set(allShards())
      : new Set([...dirty].map((id) => shardIndex(id)))
  if (indices.size === 0) return 0
  const buckets = new Map<number, Record<string, CachedTrace>>()
  for (const i of indices) buckets.set(i, {})
  for (const [id, cached] of traces) {
    const bucket = buckets.get(shardIndex(id))
    if (bucket) bucket[id] = cached
  }
  const updatedAt = Date.now()
  await Promise.all(
    [...buckets].map(([i, bucket]) =>
      kv.put(traceShardKey(pool, i), JSON.stringify({ traces: bucket, updatedAt }))
    )
  )
  if (dirty === "all") {
    await kv.put(
      traceManifestKey(pool),
      JSON.stringify({ version: 2, shards: SHARD_COUNT, migratedAt: updatedAt })
    )
  }
  return buckets.size
}

// ------------------------------------------------------------- inventory

type InventoryMeta = Omit<FlowInventory, "flows"> & {
  version: 2
  shards: number
}

export type LoadedInventory = {
  inventory: FlowInventory | null
  legacy: boolean
}

const byBlockTimeDesc = (
  a: FlowInventory["flows"][number],
  b: FlowInventory["flows"][number]
) => (b.blockTime ?? 0) - (a.blockTime ?? 0)

export async function loadInventoryStore(
  kv: KVLike,
  pool: ShardedPool
): Promise<LoadedInventory> {
  const metaRaw = await kv.get(inventoryMetaKey(pool))
  if (metaRaw) {
    const { version: _v, shards: _s, ...meta } = JSON.parse(metaRaw) as InventoryMeta
    const raws = await readAllShards(
      kv,
      (i) => inventoryShardKey(pool, i),
      "inventory"
    )
    const flows = raws.flatMap((raw) => JSON.parse(raw) as FlowInventory["flows"])
    flows.sort(byBlockTimeDesc)
    return { inventory: { ...meta, flows }, legacy: false }
  }
  return { inventory: parseInventory(await kv.get(inventoryKey(pool))), legacy: true }
}

/** Shards whose membership differs between two inventories. Flows are never
 *  edited in place (head/page refreshes only add or drop identities), so
 *  membership is the whole diff. */
export function changedInventoryShards(
  before: FlowInventory | null,
  after: FlowInventory
): Set<number> {
  const prev = new Set((before?.flows ?? []).map(flowIdentity))
  const next = new Set(after.flows.map(flowIdentity))
  const changed = new Set<number>()
  for (const id of next) if (!prev.has(id)) changed.add(shardIndex(id))
  for (const id of prev) if (!next.has(id)) changed.add(shardIndex(id))
  return changed
}

/** Write changed inventory shards, then the meta record (always: it carries
 *  fetchedAt/headFetchedAt, which gate the next refresh). Errors propagate. */
export async function saveInventoryStore(
  kv: KVLike,
  pool: ShardedPool,
  inventory: FlowInventory,
  loaded: LoadedInventory
): Promise<number> {
  const indices = loaded.legacy
    ? new Set(allShards())
    : changedInventoryShards(loaded.inventory, inventory)
  if (indices.size > 0) {
    const buckets = new Map<number, FlowInventory["flows"]>()
    for (const i of indices) buckets.set(i, [])
    for (const flow of inventory.flows) {
      buckets.get(shardIndex(flowIdentity(flow)))?.push(flow)
    }
    await Promise.all(
      [...buckets].map(([i, flows]) =>
        kv.put(inventoryShardKey(pool, i), JSON.stringify(flows))
      )
    )
  }
  const { flows: _flows, ...rest } = inventory
  const meta: InventoryMeta = { ...rest, version: 2, shards: SHARD_COUNT }
  await kv.put(inventoryMetaKey(pool), JSON.stringify(meta))
  return indices.size
}
