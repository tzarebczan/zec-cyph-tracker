# Perf harness

A deterministic load and idle benchmark for cyphzec.com, run against
production. It measures the journeys that matter for this site and prints
medians, and with `--assert` it fails when a median breaks `budgets.json`.

Scenarios:

- `mobile-fresh`: first visit on a mid-tier phone (4x CPU slowdown, 150 ms
  RTT, 1.6 Mbps). This is the number Lighthouse sees.
- `mobile-returning`: same phone, but with saved settings (large font, compact
  density, extra tiles). This is the layout shift Lighthouse never sees.
- `desktop-fresh`: first visit on a fast desktop.

Per scenario: TTFB, FCP, LCP and its element, first visible price, skeleton
drain, layout shift with the elements that moved, React commits, long tasks,
style recalcs, the `/api` fan-out (count, start, end), transfer size, then a
45 s idle window (API calls, commits, script time), and finally one tap
on the STATS tab: `tabFullLoads` counts the document loads it caused and
must be 0, because a tab switch that reloads the page redraws the whole
shell (this happened when OpenNext cache interception dropped the
`x-nextjs-deployment-id` header Next 16.2 checks on every RSC response).

```bash
cd scripts/perf
npm ci && npx playwright install chromium
node bench.mjs                              # all scenarios, 3 runs each
node bench.mjs mobile-fresh 5               # one scenario, 5 runs
node bench.mjs --assert                     # exit 1 on a budget miss
ORIGIN=http://127.0.0.1:8790 node bench.mjs desktop-fresh 1   # local Worker
```

Budgets are a ratchet. After a verified improvement, lower the numbers to
just above the new medians. Do not raise one without saying why in the
commit. The nightly workflow (`.github/workflows/perf-nightly.yml`) runs
`--assert` against production and uploads the raw results.

This directory is deliberately outside the pnpm workspace so the app's
install never pulls a browser.
