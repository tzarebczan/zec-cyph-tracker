# zec-cyph-tracker

CyphZec dashboard — Next.js App Router, deployed to **Cloudflare Workers** via **OpenNext**.

## Stack

| Layer | Choice |
| --- | --- |
| Package manager | **pnpm** (required) |
| Framework | Next.js 16 (App Router) |
| Edge adapter | `@opennextjs/cloudflare` |
| Runtime (prod) | Cloudflare Workers + KV |
| Local dev | `next dev` (Turbopack) with OpenNext CF bindings |

> **Why not Vite / Astro?** This app depends on Next App Router pages, 20+ Route Handlers, OG image routes, edge middleware, OpenNext KV bindings, and a custom Worker cron wrapper. Migrating frameworks would rewrite production, not fix local startup. Stay on Next + OpenNext.

## Prerequisites

- **Node.js** ≥ 20.9
- **pnpm** ≥ 9 (this repo pins `packageManager: pnpm@11.0.9`)

```bash
# enable corepack (ships with Node) so the pinned pnpm is used
corepack enable
corepack prepare pnpm@11.0.9 --activate
```

## Local development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

`next.config.mjs` calls `initOpenNextCloudflareForDev()` in development so `getCloudflareContext()` and the `SUPPLY_CACHE` KV binding work against your Wrangler config (`wrangler.jsonc`).

### Useful scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Local Next.js dev server (Turbopack) |
| `pnpm build` | Plain Next production build |
| `pnpm typecheck` | TypeScript check (`tsc --noEmit`) |
| `pnpm clean` | Remove `.next`, `.open-next`, `.wrangler` |
| `pnpm cf:build` | Webpack Next build + OpenNext worker bundle |
| `pnpm cf:preview` | Preview the OpenNext worker locally (Miniflare) |
| `pnpm cf:deploy` | Deploy to Cloudflare + purge CDN cache |
| `pnpm cf:typegen` | Generate `cloudflare-env.d.ts` from Wrangler |

## Cloudflare production

Production entry is `custom-worker.ts` (OpenNext handler + scheduled jobs). Assets and KV are configured in `wrangler.jsonc`.

```bash
# full worker build (use this before deploy / to debug CF output)
pnpm cf:build

# local worker preview (closer to prod than next dev)
pnpm cf:preview

# deploy (requires Cloudflare auth: wrangler login / CI secrets)
pnpm cf:deploy
```

Cache purge after deploy needs `CF_KEY` (and optionally `CF_ZONE_ID` / `CF_ZONE_NAME`) — see `scripts/purge-cf-cache.mjs`.

## Troubleshooting

### `next` is not recognized / empty packages

Usually a corrupted or incomplete `node_modules` (common on Windows after interrupted installs or path issues).

```bash
# stop any running next/dev processes, then:
# 1) move or delete node_modules (if delete fails, rename it and move outside the repo)
# 2) reinstall
pnpm install
pnpm dev
```

If Windows reports **os error 1392** (directory corrupted/unreadable), rename the broken folder and **move it outside the project root** — Turbopack will scan sibling `node_modules_*` dirs and crash on corrupted trees.

### Port already in use

```bash
# Windows PowerShell — find and stop the process on 3000
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

### Middleware deprecation warning

Next 16 prefers `proxy.ts`, but Node middleware is not yet supported by OpenNext/Cloudflare. Keep `middleware.ts` (edge) until OpenNext supports the new convention. See comments in `middleware.ts`.

## Project layout (high level)

```
app/                 # App Router pages + API route handlers
components/          # UI + dashboard widgets
lib/                 # shared logic, jobs, unshieldings helpers
custom-worker.ts     # Cloudflare Worker entry (OpenNext + cron)
open-next.config.ts  # OpenNext Cloudflare adapter config
wrangler.jsonc       # Workers name, KV, routes, crons
next.config.mjs      # Next + OpenNext dev init + standalone output
```
