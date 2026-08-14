# Contributing to CyphZec

CyphZec is a public Zcash analytics app. Keep data accurate, keep
portfolio data on-device, and treat upstream market and chain APIs as
untrusted input.

## Setup

Node.js 20.9+ and pnpm 9+ (see `packageManager` in `package.json`).

```bash
corepack enable
pnpm install
pnpm dev
```

## Pull requests

- Open an issue first for large changes.
- Keep PRs focused. Branch from `main`.
- Never commit API keys, secrets, or user data.
- Validate API shapes and keep a labeled stale-data fallback.
- Do not claim that an aggregate on-chain observation identifies a
  person, exchange, or sale without evidence.

Before review:

```bash
pnpm typecheck
pnpm build
```

For Worker, KV, or cron changes, also run `pnpm cf:build`.

These expectations follow the same ideas as the Zcash `librustzcash`
contribution guide: reviewable diffs, explicit invariants, and no
warning debt.

## Security

Do not file public issues for exploitable bugs. Email
`thomas.zarebczan@gmail.com` with the route, steps, and impact.
