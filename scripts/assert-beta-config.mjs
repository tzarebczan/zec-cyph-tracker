import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
const config = JSON.parse(await readFile(new URL("../wrangler.beta.jsonc", import.meta.url), "utf8"))
assert.equal(config.name, "zec-cyph-tracker-beta")
assert.equal(config.main, "beta-worker.ts", "Beta must use the HTTP-only entry, without the production scheduler wrapper")
assert.deepEqual(config.routes, [{ pattern: "beta.cyphzec.com", custom_domain: true }])
assert.deepEqual(config.triggers?.crons, [])
assert.equal(config.durable_objects, undefined)
assert.equal(config.migrations, undefined)
assert.equal(config.kv_namespaces.length, 2)
for (const binding of config.kv_namespaces) {
  assert(["SUPPLY_CACHE", "NEXT_INC_CACHE_KV"].includes(binding.binding))
  assert.equal(binding.id, "a37644bc0b24452bb252fc88fcfff532", "Beta must use its own cache namespace")
}
assert.deepEqual(config.services, [{ binding: "WORKER_SELF_REFERENCE", service: "zec-cyph-tracker-beta" }])
console.log("Beta deployment is isolated to beta.cyphzec.com with its own cache and no scheduled jobs.")
