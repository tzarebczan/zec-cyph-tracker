# Embedded CYPH wallet

The floating CYPH wallet opens Coffer at `https://cofferwallet.com/?embed=1`.
The iframe is created after the visitor opens the panel. It remains mounted
when the panel closes so reopening does not discard wallet progress.

The panel offers compact, simple and full views. Its Cypherpunk accent follows
the site's selected palette. The full-wallet link opens the official Coffer
site. Embedded and top-level storage may differ, so that tab can require a
separate sign-in.

`lib/coffer-embed.ts` sends only the Coffer version 1 initialization message.
It requests no balance, history, identity or spending permissions. Every incoming
message must match both the wallet's exact origin and this iframe's WindowProxy.
Keys and recovery phrases stay inside Coffer. cyphzec's manual portfolio remains
separate from actual wallet holdings.

Coffer owns enablement, prices, balances, trade quotes, confirmation and signing.
This integration does not construct or sign transactions, supply provider URLs,
collect recovery phrases, proxy credentials or infer settlement from a timeout.
Tokenized CYPH and other Solana holdings have public on-chain balances and
transaction history.

For a local integration test, start Coffer's wallet server, then start cyphzec:

```sh
NEXT_PUBLIC_COFFER_WALLET_URL=http://localhost:5173/ pnpm dev
```

The override is permitted only during development, and accepts only an HTTP
loopback origin or the official HTTPS wallet origin. Production always embeds
the official wallet. The iframe's passkey policy targets the official origin;
passkey validation should use the real deployed origin.

Validate with `pnpm typecheck` followed by `pnpm build`. Do not run these
concurrently because Next regenerates `.next/types` during a build. Browser
checks should cover the unopened launcher, first open, close and reopen, all
three views, keyboard focus and Escape, a narrow mobile viewport, provider or
frame failure, and the full-wallet link. Verify sign-in and browser isolation
on the actual host before merging. No funded trade is required for these checks.
