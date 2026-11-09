// Offline check for the sharded KV store, the size guard, the request-path
// policy and a full scheduled run, against a fake KV that enforces the real
// 25 MiB value cap. No network: fetch is stubbed.
//
//   npx -y tsx --tsconfig tsconfig.json scripts/kv-check/check.ts
//
// Sizes mirror production in Nov 2026 (ironwood 98,864 flows / 30,541 traces,
// orchard 32,115 / 28,617, sapling 12,121 / 12,120), so the timing printed
// for the scheduled run is a rough local stand-in for its CPU cost.

import sample from "./traces-sample.json"
import {
  SHARD_LIMITS,
  guardedPut,
  loadInventoryStore,
  loadTraces,
  manifestKey,
  readStorageHealth,
  saveTraces,
  type ShardedPool,
} from "../../lib/unshieldings/kv-store"
import {
  flowIdentity,
  inventoryKey,
  progressKey,
  responseCacheKey,
  traceBlobKey,
} from "../../lib/unshieldings/shared"
import { requestNeedsBuild, runUnshieldingWorker } from "../../lib/unshieldings/worker"
import { runScheduledJobs } from "../../lib/jobs/scheduled"
import { poolWarnings, readPoolHealth } from "../../lib/unshieldings/health"

const KV_CAP = 25 * 1024 * 1024

class FakeKV {
  m = new Map<string, string>()
  ttl = new Map<string, number | undefined>()
  puts: string[] = []
  gets = 0
  bytesRead = 0
  failPut: ((k: string) => boolean) | null = null
  big: string[] = []
  byPrefix = new Map<string, number>()
  async get(k: any): Promise<any> {
    this.gets++
    const v = this.m.get(k) ?? null
    if (v) this.bytesRead += v.length
    if (v && v.length > 4_000_000) this.big.push(k)
    if (v) {
      const prefix = String(k).replace(/\.n\d+\.\d+$/, ".n*").replace(/\.v9\..*/, ".v9.*")
      this.byPrefix.set(prefix, (this.byPrefix.get(prefix) ?? 0) + v.length)
    }
    return v
  }
  async put(k: string, v: string, o?: { expirationTtl?: number }) {
    if (this.failPut?.(k)) throw new Error("injected put failure")
    const b = Buffer.byteLength(v)
    if (b > KV_CAP) throw new Error(`KV value too large: ${k} ${b}`)
    this.puts.push(k)
    this.m.set(k, v)
    this.ttl.set(k, o?.expirationTtl)
  }
  async delete(k: string) {
    this.m.delete(k)
  }
  reset() {
    this.big = []
    this.byPrefix = new Map()
    this.puts = []
    this.gets = 0
    this.bytesRead = 0
  }
}

let failures = 0
const check = (cond: unknown, msg: string) => {
  console.log(cond ? "ok  " : "FAIL", msg)
  if (!cond) failures++
}

const fetchLog: string[] = []
let traceMocks = false
;(globalThis as any).fetch = async (url: URL | string) => {
  const u = String(url)
  fetchLog.push(u)
  if (u.includes("/shielded/list")) {
    return new Response(JSON.stringify({ success: true, flows: [] }))
  }
  if (u.includes("/pools/flows")) {
    return new Response(JSON.stringify({ points: [] }))
  }
  if (traceMocks && u.includes("/address/")) {
    // Held, no later spend: one request per flow, like most real lookups.
    return new Response(JSON.stringify({ balance: 5, totalReceived: 5, txCount: 1, transactions: [] }))
  }
  if (traceMocks && u.includes("/tx/")) {
    return new Response(JSON.stringify({}))
  }
  throw new Error("offline")
}

// ---------------------------------------------------------------- fixtures
const traceTemplate = (sample as any[])[0]
// Relative to now so the 7-day recent window lines up with the fixture.
const T0 = Math.floor(Date.now() / 1000) - 5 * 60
function seedPool(kv: FakeKV, pool: ShardedPool, flowCount: number, traced: number) {
  const flows = Array.from({ length: flowCount }, (_, i) => ({
    id: i,
    txid: `${pool}${i.toString(16).padStart(60, "0")}`,
    addresses: [`t1${pool}${i.toString(36).padStart(28, "x")}`],
    flowType: "deshield",
    pool,
    blockTime: T0 - i * 60,
    blockHeight: 3_555_000 - i,
    amountZec: 1 + (i % 97),
    time: new Date((T0 - i * 60) * 1000).toISOString(),
  }))
  const traces: Record<string, unknown> = {}
  for (let i = 0; i < traced; i++) {
    const f = flows[i]
    traces[flowIdentity(f as any)] = {
      trace: { ...traceTemplate, hash: f.txid, address: f.addresses[0], amountZec: f.amountZec, time: f.time },
      checkedAt: 1,
      lastAttemptAt: 1,
    }
  }
  kv.m.set(traceBlobKey(pool), JSON.stringify({ traces, updatedAt: 1 }))
  kv.m.set(
    inventoryKey(pool),
    JSON.stringify({
      flows,
      // Older than INVENTORY_REFRESH_MS, as it is in production between runs.
      fetchedAt: Date.now() - 10 * 60_000,
      headFetchedAt: Date.now() - 10 * 60_000,
      complete: true,
      nextCursor: null,
      nextCursorId: null,
      source: "fixture",
    })
  )
  return flows
}

class FakeLocks {
  held = new Map<string, string>()
  idFromName(n: string) {
    return n
  }
  get(id: unknown) {
    const name = String(id)
    return {
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        if (url.endsWith("/acquire")) {
          if (this.held.has(name)) return Response.json({ token: null })
          const token = Math.random().toString(36).slice(2)
          this.held.set(name, token)
          return Response.json({ token })
        }
        const ok = this.held.get(name) === body.token
        if (ok) this.held.delete(name)
        return Response.json({ released: ok })
      },
    }
  }
}

const ironwoodMinute = new Date("2026-11-09T17:00:00Z") // :00 -> ironwood
const orchardMinute = new Date("2026-11-09T17:02:00Z") // :02 -> orchard

async function main() {
  // ------------------------------------------------------ 1. guard
  {
    const kv = new FakeKV()
    const saved = SHARD_LIMITS.maxValueBytes
    SHARD_LIMITS.maxValueBytes = 1000
    const err = await guardedPut(kv as any, "big", "x".repeat(1001)).then(() => null, (e) => e.message)
    check(err?.includes("refusing KV put big") && !kv.m.has("big"), `guard refuses oversize value: ${err}`)
    SHARD_LIMITS.maxValueBytes = saved
  }

  // ------------------------------------------------------ 2. adaptive re-shard
  {
    const kv = new FakeKV()
    seedPool(kv, "sapling", 4000, 4000)
    const loaded = await loadTraces(kv as any, "sapling")
    const savedTarget = SHARD_LIMITS.targetShardBytes
    SHARD_LIMITS.targetShardBytes = 64 * 1024 // force growth past 16 shards
    const m = await saveTraces(kv as any, "sapling", loaded, "all")
    check(m.shards > 16 && Math.max(...m.sizes) <= 64 * 1024, `re-shards to fit target: ${m.shards} shards, max ${Math.max(...m.sizes)} B`)
    // Grow one shard past the target via a partial save: must switch layout.
    const before = m.shards
    const reloaded = await loadTraces(kv as any, "sapling")
    const dirty = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const id = `extra${i}:t1`
      reloaded.traces.set(id, { trace: { ...traceTemplate, hash: id }, checkedAt: 2 })
      dirty.add(id)
    }
    const m2 = await saveTraces(kv as any, "sapling", reloaded, dirty)
    const again = await loadTraces(kv as any, "sapling")
    check(m2.shards > before && again.traces.size === 7000, `partial save that outgrows target re-shards (${before} -> ${m2.shards}), all entries kept`)
    const oldKeys = [...kv.m.keys()].filter((k) => k.includes(`.n${before}.`))
    check(oldKeys.length === 0, "old layout deleted after re-shard")
    SHARD_LIMITS.targetShardBytes = savedTarget
  }

  // ------------------------------------------------------ 3. scheduled migration (production sizes)
  const kv = new FakeKV()
  seedPool(kv, "ironwood", 98_864, 30_541)
  seedPool(kv, "orchard", 32_115, 28_617)
  seedPool(kv, "sapling", 12_121, 12_120)
  const legacyBytes = kv.m.get(traceBlobKey("ironwood"))!.length
  console.log(`     legacy ironwood blob ${legacyBytes} B, inventory ${kv.m.get(inventoryKey("ironwood"))!.length} B (cap ${KV_CAP})`)
  const env = { SUPPLY_CACHE: kv as any, SCHEDULER_LOCK: new FakeLocks() as any }

  let t = performance.now()
  let res = await runScheduledJobs(env, "0,2,7,10,20,30,32,37,40,50 * * * *", ironwoodMinute)
  const firstRunMs = performance.now() - t
  check(res.some((r) => r.ok && !r.skipped), `ironwood job ok: ${JSON.stringify(res.filter((r) => !r.skipped))}`)
  check(kv.m.has(manifestKey("traces", "ironwood")) && kv.m.has(manifestKey("inventory", "ironwood")), "ironwood migrated: trace + inventory manifests written")
  const health = await readStorageHealth(kv as any, "ironwood")
  console.log("     ironwood health", JSON.stringify(health))
  check(health.traces.migrated && health.traces.largestShardBytes < 8 * 1024 * 1024, "trace shards under 8 MiB target")
  check(kv.m.get(traceBlobKey("ironwood"))!.length === legacyBytes, "legacy blob left untouched")
  const presets = ["1h", "12h", "1d", "1w", "1m", "all"].flatMap((p) =>
    ["recent", "largest"].flatMap((s) => [0, 24].map((c) => responseCacheKey("ironwood", p as any, s as any, 24, c)))
  )
  check(presets.every((k) => kv.m.has(k) && (kv.ttl.get(k) ?? 0) >= 30 * 60), `all ${presets.length} ironwood presets built with TTL >= 30 min`)
  const allPreset = responseCacheKey("all", "1d", "recent", 24, 0)
  check(kv.m.has(allPreset), "merged `all` presets built on the ironwood job")
  const p1 = JSON.parse(kv.m.get(progressKey("ironwood"))!)
  console.log(`     first ironwood run ${firstRunMs.toFixed(0)} ms (migration + presets), progress ${p1.classified}/${p1.total}`)

  // Second run: partial writes only, classified count is persisted.
  kv.reset()
  t = performance.now()
  res = await runScheduledJobs(env, "x", new Date("2026-11-09T17:10:00Z"))
  const secondRunMs = performance.now() - t
  const shardPuts = kv.puts.filter((k) => k.includes(".n")).length
  const reloaded = await loadTraces(kv as any, "ironwood")
  console.log(`     second ironwood run ${secondRunMs.toFixed(0)} ms, ${kv.puts.length} puts (${shardPuts} shard), read ${(kv.bytesRead / 1e6).toFixed(1)} MB`)
  if (kv.big.length) console.log("     big reads:", kv.big.join(", "))
  console.log("     reads by key:", JSON.stringify([...kv.byPrefix].filter(([, b]) => b > 1e6).map(([k, b]) => [k, Math.round(b / 1e6)])))
  check(shardPuts > 0 && shardPuts <= 32, "second run rewrites only touched shards")
  // Offline fetches fail: each flow then costs 2 requests, so each run does
  // at most 37 flows within its 75-request budget.
  const added = reloaded.traces.size - 30_541
  check(added > 0 && added <= 2 * 37, `traces persisted across runs: +${added}`)

  // Orchard run migrates orchard.
  res = await runScheduledJobs(env, "x", orchardMinute)
  check(kv.m.has(manifestKey("traces", "orchard")), "orchard migrated on its run")

  // ------------------------------------------------------ 4. request path
  check(requestNeedsBuild(Date.now() - 3_600_000, 24, null, true) === false, "prebuilt page: cached (even old, even ?refresh) -> no build")
  check(requestNeedsBuild(null, 24, 0, false) === true, "prebuilt page: hard miss -> build")
  check(requestNeedsBuild(Date.now() - 60_000, 24, 48, false) === false, "off-preset page fresh -> no build")
  check(requestNeedsBuild(Date.now() - 11 * 60_000, 24, 48, false) === true, "off-preset page older than 10 min -> build")

  kv.reset()
  fetchLog.length = 0
  t = performance.now()
  await runUnshieldingWorker("ironwood", kv as any, {
    classify: false,
    refreshInventory: false,
    buildResponses: true,
    buildAllPresets: false,
    responseTtlSeconds: 900,
    prioritize: { period: "all", sort: "recent", limit: 24, cursor: 48 },
  })
  const reqMs = performance.now() - t
  const deepKey = responseCacheKey("ironwood", "all", "recent", 24, 48)
  const nonResponsePuts = kv.puts.filter((k) => !k.startsWith("zec.unshieldings.v9.") && !k.startsWith("zec.unshieldings.stale.v9."))
  check(kv.m.has(deepKey), "off-preset request build writes its page")
  check(nonResponsePuts.length === 0, `request build writes nothing but response caches (${nonResponsePuts.join(",") || "none"})`)
  check(!fetchLog.some((u) => u.includes("/shielded/list")), "request build never fetches the upstream inventory")
  console.log(`     off-preset request build ${reqMs.toFixed(0)} ms, read ${(kv.bytesRead / 1e6).toFixed(1)} MB (only on a miss / every 10 min per page)`)

  // ------------------------------------------------------ 5. failures surface
  kv.failPut = (k) => k.includes("traces.v3.ironwood.n")
  res = await runScheduledJobs(env, "x", new Date("2026-11-09T17:20:00Z"))
  const state = JSON.parse(kv.m.get("jobs.scheduler.v1.unshieldings.ironwood.state")!)
  check(state.ok === false && String(state.reason).includes("trace save"), `failed save shows in scheduler state: ${state.reason}`)
  kv.failPut = null

  const traceShards = JSON.parse(kv.m.get(manifestKey("traces", "ironwood"))!).shards
  kv.m.delete(`zec.unshieldings.traces.v3.ironwood.n${traceShards}.3`)
  const missing = await loadTraces(kv as any, "ironwood").then(() => "loaded", (e) => e.message)
  check(missing.includes("missing"), `missing shard is an error: ${missing}`)

  const inv = await loadInventoryStore(kv as any, "sapling")
  check(
    inv.inventory?.flows.length === 12_121 && (inv.inventory.flows[0].blockTime ?? 0) >= (inv.inventory.flows[1].blockTime ?? 0),
    "inventory store round trip, sorted"
  )

  // ------------------------------------------------------ 6. newest first
  {
    traceMocks = true
    const kv = new FakeKV()
    const env = { SUPPLY_CACHE: kv as any, SCHEDULER_LOCK: new FakeLocks() as any }
    // Like production: the newest flows are untraced while the backlog cursor
    // sits deep in history. 30 new flows (about one run's worth), then traced
    // flows, then an untraced old backlog.
    const flows = seedPool(kv, "ironwood", 20_000, 0)
    const traces: Record<string, unknown> = {}
    for (let i = 30; i < 15_000; i++) {
      const f = flows[i]
      traces[flowIdentity(f as any)] = { trace: { ...traceTemplate, hash: f.txid, address: f.addresses[0] }, checkedAt: 1, lastAttemptAt: 1 }
    }
    kv.m.set(traceBlobKey("ironwood"), JSON.stringify({ traces, updatedAt: 1 }))
    kv.m.set(progressKey("ironwood"), JSON.stringify({ total: 20_000, classified: 14_970, lastRunAt: Date.now() - 600_000, complete: false, scanOffset: 15_000 }))

    fetchLog.length = 0
    res = await runScheduledJobs(env, "x", ironwoodMinute)
    check(res.some((r) => r.ok && !r.skipped), "newest-first run ok")
    const after = await loadTraces(kv as any, "ironwood")
    const newOnes = flows.slice(0, 30).filter((f) => after.traces.get(flowIdentity(f as any))?.trace)
    check(newOnes.length === 30, `all 30 newest flows classified in one run (${newOnes.length})`)
    const backlog = flows.slice(15_000).filter((f) => after.traces.has(flowIdentity(f as any))).length
    const upstream = fetchLog.filter((u) => u.includes("/address/") || u.includes("/tx/")).length
    check(backlog > 0, `remaining budget spent on the backlog (+${backlog})`)
    check(upstream <= 75, `CipherScan requests within the 75/run budget (${upstream})`)
    const prog = JSON.parse(kv.m.get(progressKey("ironwood"))!)
    console.log("     recent stats", JSON.stringify(prog.recent))
    check(prog.recent?.pending === 0 && prog.recent.ranRecent === 30 && prog.recent.requests === upstream, "progress.recent reports the window and the run")
    check(prog.lastGrowthAt > 0, "progress.lastGrowthAt set when classified grows")
    check(prog.scanOffset > 15_000, `backlog cursor advanced (${prog.scanOffset})`)

    const health = await readPoolHealth(kv as any, "ironwood")
    const now = Date.now()
    check(poolWarnings("ironwood", health, now).length === 0, `healthy pool has no warnings: ${JSON.stringify(poolWarnings("ironwood", health, now))}`)

    // Regression guards: a recent flow pending > 1h, and a stalled backlog.
    const stale = {
      ...health,
      progress: {
        ...health.progress!,
        lastGrowthAt: now - 3 * 3_600_000,
        recent: { ...health.progress!.recent!, pending: 4, oldestPendingAt: now - 2 * 3_600_000 },
      },
    }
    const w = poolWarnings("ironwood", stale, now)
    console.log("     warnings", JSON.stringify(w))
    check(w.some((x) => x.includes("recent flows not yet classified")), "warns when a recent flow is pending over 1h")
    check(w.some((x) => x.includes("backlog not moving")), "warns when the backlog stops growing for 2h")
    traceMocks = false
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL OK")
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
