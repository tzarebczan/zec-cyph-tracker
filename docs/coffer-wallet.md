# Embedded CYPH wallet

The floating CYPH wallet opens Coffer at `https://cofferwallet.com/?embed=1`.
The iframe is created after the visitor opens the panel. It remains mounted
when the panel closes so reopening does not discard wallet progress.

The panel has no header row; its title is visually hidden text. The footer holds the full-Coffer link, a segmented Compact / Simple / Full control (three 44px icon buttons with accessible names, `aria-pressed` and a native `title`), help and close. Footer items are left-packed at fixed sizes, so the size control keeps its place when the panel width changes. Compact is a 364 × 540px panel, bounded to 80% of a mobile viewport; simple is a larger 500 × 760px panel, and full uses the available wallet area. The frame owns its scrolling, while the footer stays in place. Its Cypherpunk accent follows
the site's selected palette. The full-wallet link opens the official Coffer
site. Embedded and top-level storage may differ, so that tab can require a
separate sign-in.

`lib/coffer-embed.ts` sends only the Coffer version 1 initialization message.
It requests no balance, history, identity or spending permissions. Every incoming
message must match both the wallet's exact origin and this iframe's WindowProxy.
Keys and recovery phrases stay inside Coffer. cyphzec's manual portfolio remains
separate from actual wallet holdings.

Compact and simple open Coffer’s wallet overview with its existing Zcash balance, receiving controls and payment entry points. CYPH exploration is a secondary opt-in. Full opens Coffer’s existing full wallet interface.

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
the official wallet. The launcher can be hidden in site Settings; this preference survives reloads and does not delete a Coffer wallet. No iframe is created while it is hidden or before the launcher is opened. The iframe's passkey, camera and clipboard policies target only the selected trusted wallet origin;
passkey validation should use the real deployed origin.

## Launcher

The floating launcher comes in three looks, chosen under Settings, CYPH
WALLET: MARK (round Coffer mark), WALLET (mark, key glyph, "Wallet", "by
Coffer"; the default) and PILL ("Coffer · CYPH"). The mark is the geometry of
Coffer's `coffer-signal.svg`, stroked in the active palette.

A grip beside the button drags it with a mouse, pen or finger. On a touch
screen the button itself also drags after a long press; a quick swipe that
starts on it still scrolls the page. On release it snaps to the nearer side
edge, kept inside the safe area and above the mobile bottom tabs. Arrow keys
on the grip move it. Its side and height are saved in
`cyphzec.walletLauncher.position.v1`; Reset in Settings or in the grip's card
clears them. The launcher moves with `top`/`left`/`right` only and is hidden
while the panel is open, so it never covers the wallet frame.

Tapping the grip opens a small card with one Open action. It shows no
balances: the host cannot read them, and Coffer has no small balance view yet.
`WalletLauncher` accepts a `holdingsSrc` for a future Coffer-hosted view,
which the host would only position. The launcher records
`cyphzec.walletLauncher.opened.v1` on first open so such a view can stay
unloaded until the wallet has been used on this device.

Nothing from cyphzec may sit over the frame: help opens inline above the
footer and the view buttons use only a native `title`, because Coffer refuses
payment and consent actions when its frame is covered, transparent or
transformed. An older stored `cofferWalletHeader` setting is ignored on read.

Validate with `pnpm typecheck` followed by `pnpm build`. Do not run these
concurrently because Next regenerates `.next/types` during a build. Browser
checks should cover the unopened launcher, first open, close and reopen, all
three views, keyboard focus and Escape, a narrow mobile viewport, provider or
frame failure, and the full-wallet link. Verify sign-in and browser isolation
on the actual host before merging. No funded trade is required for these checks.


## Beta preview deployment

`beta.cyphzec.com` uses the separate `zec-cyph-tracker-beta` worker, configured by
`wrangler.beta.jsonc`. Its HTTP-only entry is `beta-worker.ts`; it does not import
the production scheduler, has no cron triggers or Durable Object bindings, and
uses the dedicated `CYPHZEC_BETA_CACHE` namespace for both data and OpenNext cache.
Cache API keys in the data routes use the incoming request origin. No wallet
provider keys or production scheduler credentials belong in this host.

The beta response and iframe policies permit camera, clipboard and passkeys only
for the site itself and the official Coffer origin. Those capabilities still
require browser support and explicit visitor gestures. Manual input, QR image
import and the full-Coffer link remain the fallback. An external tab may require
a separate sign-in because embedded storage and passkeys can be partitioned.

Build and deploy beta explicitly:

```sh
pnpm typecheck
pnpm cf:build:beta
pnpm cf:deploy:beta
```

`assert-beta-config.mjs` refuses production routes, production caches or a
scheduled-worker entry. Do not use `cf:deploy` for a preview: it targets the
production worker and purges production cache. The production config omits the
old beta mirror so a later production deployment cannot take the beta hostname
back. The one-time move changes only the beta custom-domain association.

Verify the beta worker version and `/api/version`, permissions header, private
wallet lazy-loading, settings persistence, all three views, mobile scrolling,
close/reopen and full-wallet handoff. Compare the production worker version and
`https://cyphzec.com/api/version` before and after. Authenticated wallet functions
require the matching Coffer release; route/UI fixtures do not prove a funded
payment or an actual trade.

The screenshots in `docs/screenshots/coffer-wallet-{1280,390,320}.png` are paired
local integration fixtures using the actual host component and wallet App/bridge,
with production wallet CSS and public synthetic wallet data. They are not a live
balance, passkey-provider or funded-trade demonstration. The paired Coffer script
checks all three modes at 1280×900, 1261×545, 390×844 and 320×568, six existing
wallet navigation actions, the help disclosure, and unchanged CYPH enablement.
No iframe height or mode change grants the host wallet permissions.
