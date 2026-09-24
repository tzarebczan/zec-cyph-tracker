#!/usr/bin/env node
// Deterministic load + idle benchmark for cyphzec.com.
//
// Measures the journeys that matter for this site and prints medians:
//   - fresh load on a throttled phone (the LCP that Lighthouse sees)
//   - fresh load on desktop
//   - a returning user with non-default settings (the layout shift Lighthouse never sees)
// For each: TTFB, FCP, LCP (+ element), first visible price, skeleton drain, layout
// shift with sources, React commits, long tasks, style recalcs, the /api fan-out
// (count, start, end), then a fixed idle window (API calls, commits, script time).
//
// Usage:
//   node bench.mjs                       # all scenarios, 3 runs each, print JSON
//   node bench.mjs mobile-fresh 5        # one scenario, 5 runs
//   node bench.mjs --assert              # fail (exit 1) if any median breaks budgets.json
//   ORIGIN=http://127.0.0.1:8790 node bench.mjs desktop-fresh 1
//
// React commits are counted through a stub of the DevTools hook, which React
// calls in production builds too; nothing on the page changes.
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ORIGIN = (process.env.ORIGIN ?? 'https://cyphzec.com').replace(/\/$/, '')
const PATHNAME = process.env.PATHNAME ?? '/'
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const ASSERT = flags.has('--assert')
const SCENARIOS = args[0] ? [args[0]] : ['mobile-fresh', 'mobile-returning', 'desktop-fresh']
const RUNS = Number(args[1] ?? process.env.RUNS ?? 3)
const IDLE_MS = Number(process.env.IDLE_MS ?? 45_000)
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 10_000)
const OUT = process.env.OUT ?? null

// Mid-tier phone: 4x CPU slowdown, 150 ms RTT, 1.6 Mbps down (Lighthouse's "slow 4G").
const MOBILE_NET = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 }
const MOBILE_CPU = 4

// Settings a returning user might have saved. Large font + compact density is
// the combination that re-flows the whole shell if applied after hydration.
const RETURNING_SETTINGS = {
  palette: 'amber', density: 'compact', fontSize: 'large', background: 'grid', vignette: false, glow: 40, motion: 'full',
  ticker: true, tickerSpeed: 3, tickerChips: ['btc', 'eth', 'sol', 'spx', 'gold', 'cyph', 'zec', 'ratio'],
  buttonBar: ['home', 'rank', 'exchanges', 'port', 'more'],
  headerBar: ['home', 'bitcoin', 'rank', 'shielding', 'port', 'est', 'trsy', 'updates', 'settings'],
  dashboardTiles: ['cyph', 'zec', 'ratio', 'portfolio'], ironwoodBanner: true, depthTile: true, depthSection: true, cyphDepthTile: true,
}

// Runs in the page before any script: counts React commits, records layout
// shifts with their sources, LCP, long tasks, first visible price and the
// skeleton count over time.
const initScript = () => {
  const b = (window.__bench = { commits: 0, cls: 0, shifts: [], lcp: null, longTasks: [], firstPriceAt: null, skeletons: [] })
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1 }, onCommitFiberRoot() { b.commits++ }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    checkDCE() {}, on() {}, off() {}, emit() {}, sub() { return () => {} },
  }
  const describe = (n) => {
    if (!n || !n.tagName) return '?'
    const cls = typeof n.className === 'string' ? '.' + n.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
    return `${n.tagName.toLowerCase()}${cls} "${(n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue
        b.cls += e.value
        b.shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), src: (e.sources || []).slice(0, 3).map((s) => describe(s.node)) })
      }
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => {
      const es = l.getEntries(); const e = es[es.length - 1]
      b.lcp = { t: Math.round(e.startTime), size: e.size, el: describe(e.element) }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) b.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) })
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  const poll = () => {
    const now = Math.round(performance.now())
    if (b.firstPriceAt == null) {
      for (const s of document.querySelectorAll('span.tabular-nums')) {
        if (/^\$\s?\d[\d,]*\.\d{2}/.test((s.textContent || '').trim())) { b.firstPriceAt = now; break }
      }
    }
    const count = document.querySelectorAll('.cz-skeleton').length
    const last = b.skeletons[b.skeletons.length - 1]
    if (!last || last.n !== count) b.skeletons.push({ t: now, n: count })
    if (now < 30_000) setTimeout(poll, 100)
  }
  poll()
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const metric = (m, k) => m.metrics.find((x) => x.name === k)?.value ?? 0

async function runOnce(scenario, browser) {
  const mobile = scenario.startsWith('mobile')
  const returning = scenario.endsWith('returning')
  const context = await browser.newContext(mobile
    ? { ...devices['iPhone 13'], locale: 'en-US', timezoneId: 'America/New_York' }
    : { viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' })
  await context.addInitScript(initScript)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (returning) {
    await page.goto(`${ORIGIN}/robots.txt`)
    await page.evaluate((s) => {
      localStorage.setItem('cyphzec.settings.v1', JSON.stringify(s))
      localStorage.setItem('cyphzec.beta.dashboard.days', JSON.stringify('30'))
    }, RETURNING_SETTINGS)
  }
  if (mobile) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', MOBILE_NET)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: MOBILE_CPU })
  }
  await page.goto(ORIGIN + PATHNAME, { waitUntil: 'load' })
  await page.waitForTimeout(SETTLE_MS)
  const m1 = await cdp.send('Performance.getMetrics')
  const load = await page.evaluate(() => {
    const b = window.__bench
    const nav = performance.getEntriesByType('navigation')[0]
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))
    const res = performance.getEntriesByType('resource')
    const api = res.filter((r) => r.name.includes('/api/') && !r.name.includes('/api/version')).map((r) => ({ u: new URL(r.name).pathname + new URL(r.name).search, start: Math.round(r.startTime), end: Math.round(r.responseEnd) }))
    const drained = b.skeletons.find((s) => s.n <= 2)
    return {
      ttfb: Math.round(nav.responseStart), fcp: paint['first-contentful-paint'] ?? null, lcp: b.lcp?.t ?? null, lcpEl: b.lcp?.el ?? null,
      firstPrice: b.firstPriceAt, skeletonsDrained: drained ? drained.t : null, skeletonsAtStart: Math.max(0, ...b.skeletons.map((s) => s.n)),
      skeletonsLeft: b.skeletons.at(-1)?.n ?? 0, cls: +b.cls.toFixed(4), shifts: b.shifts.slice(0, 12), commits: b.commits,
      longTasks: b.longTasks.length, longTaskMs: b.longTasks.reduce((s, t) => s + t.d, 0),
      apiCount: api.length, apiStart: api.length ? Math.min(...api.map((a) => a.start)) : null, apiEnd: api.length ? Math.max(...api.map((a) => a.end)) : null,
      resources: res.length, transferKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
    }
  })
  const commitsBefore = load.commits
  const apiBefore = load.apiCount
  await page.waitForTimeout(IDLE_MS)
  const m2 = await cdp.send('Performance.getMetrics')
  const idle = await page.evaluate(() => ({
    commits: window.__bench.commits,
    api: performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/') && !r.name.includes('/api/version')).length,
  }))
  const d = (k) => metric(m2, k) - metric(m1, k)
  await context.close()
  return {
    scenario, load: { ...load, scriptMs: Math.round(metric(m1, 'ScriptDuration') * 1000), taskMs: Math.round(metric(m1, 'TaskDuration') * 1000), recalcStyles: metric(m1, 'RecalcStyleCount'), layouts: metric(m1, 'LayoutCount'), nodes: metric(m1, 'Nodes'), heapMB: Math.round(metric(m1, 'JSHeapUsedSize') / 1e6) },
    idle: { windowMs: IDLE_MS, commits: idle.commits - commitsBefore, api: idle.api - apiBefore, scriptMs: Math.round(d('ScriptDuration') * 1000), taskMs: Math.round(d('TaskDuration') * 1000), recalcStyles: d('RecalcStyleCount'), layouts: d('LayoutCount') },
  }
}

function summarize(scenario, runs) {
  const L = (f) => median(runs.map((r) => f(r.load)))
  const I = (f) => median(runs.map((r) => f(r.idle)))
  return {
    scenario, runs: runs.length,
    ttfb: L((l) => l.ttfb), fcp: L((l) => l.fcp), lcp: L((l) => l.lcp), lcpEl: runs[0].load.lcpEl,
    firstData: L((l) => l.firstPrice ?? l.skeletonsDrained), skeletonsDrained: L((l) => l.skeletonsDrained), skeletonsAtStart: L((l) => l.skeletonsAtStart),
    cls: L((l) => l.cls), commits: L((l) => l.commits), longTasks: L((l) => l.longTasks), longTaskMs: L((l) => l.longTaskMs),
    apiCount: L((l) => l.apiCount), apiStart: L((l) => l.apiStart), apiEnd: L((l) => l.apiEnd),
    scriptMs: L((l) => l.scriptMs), taskMs: L((l) => l.taskMs), recalcStyles: L((l) => l.recalcStyles), transferKB: L((l) => l.transferKB),
    idleApiPer45s: I((i) => Math.round((i.api * 45_000) / i.windowMs)), idleCommits: I((i) => i.commits), idleScriptMs: I((i) => i.scriptMs),
    worstShifts: runs.flatMap((r) => r.load.shifts).sort((a, b) => b.v - a.v).slice(0, 3),
  }
}

function assertBudgets(summaries) {
  const budgets = JSON.parse(fs.readFileSync(path.join(here, 'budgets.json'), 'utf8'))
  const failures = []
  for (const s of summaries) {
    const b = budgets[s.scenario]
    if (!b) continue
    for (const [k, max] of Object.entries(b)) {
      const v = s[k]
      if (v == null) { failures.push(`${s.scenario}.${k}: no measurement`); continue }
      if (v > max) failures.push(`${s.scenario}.${k}: ${v} > budget ${max}`)
    }
  }
  return failures
}

const browser = await chromium.launch({ headless: true })
const all = []
const summaries = []
for (const scenario of SCENARIOS) {
  const runs = []
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce(scenario, browser)
    runs.push(r); all.push(r)
    console.error(`[${scenario} ${i}/${RUNS}] ttfb=${r.load.ttfb} fcp=${r.load.fcp} lcp=${r.load.lcp} firstPrice=${r.load.firstPrice} cls=${r.load.cls} commits=${r.load.commits} api=${r.load.apiCount}@${r.load.apiStart}-${r.load.apiEnd} | idle api=${r.idle.api} commits=${r.idle.commits} script=${r.idle.scriptMs}ms`)
  }
  summaries.push(summarize(scenario, runs))
}
await browser.close()
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ origin: ORIGIN, at: new Date().toISOString(), summaries, runs: all }, null, 1))
console.log(JSON.stringify(summaries, null, 1))
if (ASSERT) {
  const failures = assertBudgets(summaries)
  if (failures.length) { console.error('\nBUDGET FAILURES:\n  ' + failures.join('\n  ')); process.exit(1) }
  console.error('\nall budgets met')
}
