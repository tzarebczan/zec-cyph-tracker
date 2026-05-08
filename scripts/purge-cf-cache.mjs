#!/usr/bin/env node
/**
 * Purge the cyphzec.com Cloudflare zone cache.
 *
 * Runs after `pnpm cf:deploy` so a freshly-deployed worker isn't shadowed
 * by a 1h-old OG image (or any other CF-edge-cached response) at any POP.
 * Without this, the new ZEC stats / accessory chips on the OG would only
 * show up to socials after the next stale-while-revalidate refresh per
 * region — sometimes hours apart.
 *
 * Configuration (env):
 *   CF_KEY        required. CF API token. Recommended scope:
 *                 zone-level "Cache Purge" permission on cyphzec.com.
 *                 Global API keys also work but use bearer-token format.
 *   CF_ZONE_ID    optional. Skip the zone-name lookup if set.
 *   CF_ZONE_NAME  optional. Defaults to "cyphzec.com".
 *
 * Behaviour:
 *   - CF_KEY missing  → log a warning and exit 0 (best-effort, so a
 *                       Workers Builds run without the secret still
 *                       deploys cleanly).
 *   - Auth / network  → exit 1, surfacing the upstream error message
 *                       so the build log makes the cause obvious.
 */

const KEY = process.env.CF_KEY
const ZONE_NAME = process.env.CF_ZONE_NAME || "cyphzec.com"
let zoneId = process.env.CF_ZONE_ID || ""

if (!KEY) {
  console.warn(
    "⚠  CF_KEY not set — skipping Cloudflare cache purge. " +
      "Set CF_KEY in the Workers Builds environment to enable."
  )
  process.exit(0)
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  })
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error(`CF API ${path}: ${res.status} ${res.statusText} (non-JSON body)`)
  }
  if (!res.ok || !json.success) {
    const errMsg =
      Array.isArray(json?.errors) && json.errors.length > 0
        ? json.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
        : `${res.status} ${res.statusText}`
    throw new Error(`CF API ${path}: ${errMsg}`)
  }
  return json
}

async function resolveZoneId() {
  if (zoneId) return zoneId
  const r = await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}`)
  const zone = Array.isArray(r.result) ? r.result[0] : null
  if (!zone?.id) {
    throw new Error(
      `Zone "${ZONE_NAME}" not found. Set CF_ZONE_ID directly to skip the lookup, ` +
        `or check that the API token has Zone:Read on this zone.`
    )
  }
  zoneId = zone.id
  return zoneId
}

async function main() {
  const id = await resolveZoneId()
  await api(`/zones/${id}/purge_cache`, {
    method: "POST",
    body: JSON.stringify({ purge_everything: true }),
  })
  console.log(`✓ Purged Cloudflare cache for zone "${ZONE_NAME}" (${id})`)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
