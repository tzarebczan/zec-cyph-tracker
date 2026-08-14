# CyphZec

Free, accountless [Zcash](https://z.cash) intelligence dashboard.

**Live:** [cyphzec.com](https://cyphzec.com)

Market data, shielded-pool flows, the Ironwood / NU6.3 migration, Cypherpunk treasury figures, and on-device portfolio tools — in one mobile-first public app. No accounts. Portfolio and cost basis never leave the browser.

## What is here

| Route | What it shows |
| --- | --- |
| [`/`](https://cyphzec.com/) | Live ZEC and CYPH prices, ratios, supply, rank |
| [`/ironwood`](https://cyphzec.com/ironwood) | Orchard → Ironwood migration tracker |
| [`/shielding`](https://cyphzec.com/shielding) | Per-pool balances and aggregate flows |
| [`/shielding/unshieldings`](https://cyphzec.com/shielding/unshieldings) | Post-unshield outcome analytics (beta) |
| [`/stats`](https://cyphzec.com/stats) | Supply, emission, transactions, rainbow |
| [`/bitcoin`](https://cyphzec.com/bitcoin) | BTC / ZEC relative performance |
| [`/holdings`](https://cyphzec.com/holdings) | Cypherpunk ZEC treasury, NAV, mNAV |
| [`/what-if`](https://cyphzec.com/what-if) | ZEC market-capture scenarios |
| [`/estimator`](https://cyphzec.com/estimator) | CYPH price at a chosen ZEC target |
| [`/portfolio`](https://cyphzec.com/portfolio) | Private local CYPH / ZEC tracker |
| [`/exchanges`](https://cyphzec.com/exchanges) | ZEC venue volume share |
| [`/updates`](https://cyphzec.com/updates) | Shipped feature history |

## Thanks

CyphZec is a dashboard on top of public Zcash and market data. It is not an explorer or indexer. The following projects and services make it possible.

**Zcash chain and privacy data**

- **[CipherScan](https://cipherscan.app)** — shielded pool balances, shield/deshield flows, Ironwood migration, and transaction classification. The Ironwood and shielding views would not exist without CipherScan’s public APIs and explorer.
- **[zecstats.com](https://zecstats.com)** — daily Zcash transaction counts.

**Treasury and company data**

- **[Cypherpunk Technologies](https://cypherpunk.com)** — disclosed ZEC holdings, acquisition history, and published mNAV. CyphZec does not speak for Cypherpunk; it only presents public figures.

**Market data**

- **Kraken** — primary ZEC spot price.
- **Yahoo Finance** — CYPH (including extended hours) and macro ticker chips.
- **CoinGecko**, **CoinPaprika**, and **CoinMarketCap** — market cap, rank, exchange volume, and fallbacks when a primary feed is rate-limited.

**Runtime**

- **[Cloudflare Workers](https://workers.cloudflare.com)** and **[OpenNext](https://opennext.js.org)** — edge hosting, KV cache, and scheduled jobs.

If you maintain one of these sources and want a correction or a different credit line, email [thomas.zarebczan@gmail.com](mailto:thomas.zarebczan@gmail.com).

## Stack

Next.js 16 App Router, React, TypeScript, SWR. Production is a Cloudflare Worker via OpenNext (`custom-worker.ts`), with KV for shared cache and a one-minute cron for bounded background jobs.

## Develop

Node.js ≥ 20.9 and pnpm ≥ 9. The repo pins `packageManager` in `package.json`.

```bash
corepack enable
corepack prepare pnpm@11.0.9 --activate
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Local Next.js (Turbopack) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | Next production build |
| `pnpm cf:build` | Webpack + OpenNext Worker bundle |
| `pnpm cf:preview` | Local Worker preview |
| `pnpm cf:deploy` | Deploy and purge CDN cache |

`CF_KEY` (and optionally `CF_ZONE_ID` / `CF_ZONE_NAME`) is only needed for post-deploy cache purge. See `scripts/purge-cf-cache.mjs`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: `thomas.zarebczan@gmail.com`.

## License

[MIT](LICENSE) © 2026 Thomas Zarebczan
