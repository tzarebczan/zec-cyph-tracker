import type { CyphLiveBook } from "../components/api-types"

/**
 * Assembles a `CyphLiveBook` from the depth bridge's two payloads.
 *
 * Pure on purpose: no Next or Cloudflare imports, so it can be run against
 * captured bridge responses with plain node (`node --experimental-strip-types`
 * or any TS runner) without standing up a Worker. The route in
 * app/api/cyph-live-book owns fetching, caching and the snapshot; this owns
 * the shape.
 */

type Level = { px: number; sz: number }

/** The bridge passes the upstream quote through under `raw`, which carries
 *  fields the normalised envelope omits — the true previous close among them,
 *  and the Level 1 best bid and ask. */
function raw(q: Record<string, unknown>): Record<string, unknown> | null {
  const r = q.raw
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** `[price, size]` string pairs, as the bridge normalises both venues. */
function levels(value: unknown): Level[] {
  if (!Array.isArray(value)) return []
  const out: Level[] = []
  for (const row of value) {
    if (!Array.isArray(row)) continue
    const px = num(row[0])
    const sz = num(row[1])
    if (px == null || px <= 0 || sz == null || sz < 0) continue
    out.push({ px, sz })
  }
  return out
}

/** Webull's `bidList` / `askList` on the quote: `[{price, volume}]` objects,
 *  one entry per side for an account with Level 1 only. */
function quoteLevels(value: unknown): Level[] {
  if (!Array.isArray(value)) return []
  const out: Level[] = []
  for (const row of value) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const px = num(r.price)
    const sz = num(r.volume)
    if (px == null || px <= 0 || sz == null || sz < 0) continue
    out.push({ px, sz })
  }
  return out
}

/** The bridge's own phase label, mapped onto the calendar's vocabulary so the
 *  rest of the app has one set of session names. `closed` is deliberately not
 *  mapped to OVERNIGHT: CYPH carries `overnightTradeFlag: 0`, so nothing is
 *  matching overnight, and what the endpoint serves then is the resting
 *  post-market book — a snapshot, which `live` reports as false. */
const SESSION_BY_PHASE: Record<string, "PRE" | "REGULAR" | "AFTER" | null> = {
  pre_market: "PRE",
  regular: "REGULAR",
  after_hours: "AFTER",
  closed: null,
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/**
 * Build the book. `depth` may be null when the bridge's depth call failed;
 * `quote` may be null when the quote call failed. With neither there is no
 * book.
 *
 * When the depth payload has no levels — Webull answers that way with
 * `ntvSize: 0` once the account's TotalView entitlement lapses, and the
 * bridge answers that way when the depth call failed — the quote's best bid
 * and ask stand in as a one-level book, flagged `l1Only`, so the tile shows
 * the live top of book rather than a day-old snapshot. Everything derived
 * from the levels (imbalance, notional) is then about that one level, which
 * the UI states.
 */
export function buildBook(depth: unknown, quote: unknown): CyphLiveBook | null {
  const d = record(depth)
  const q = record(quote)
  if (!d && !q) return null

  let bids = d ? levels(d.bids) : []
  let asks = d ? levels(d.asks) : []
  let l1Only = false
  const ntvSize = d ? num(d.ntvSize) : null

  if (bids.length === 0 && asks.length === 0) {
    const r = q ? raw(q) : null
    bids = quoteLevels(r?.bidList)
    asks = quoteLevels(r?.askList)
    if (bids.length === 0 && asks.length === 0) return null
    l1Only = true
  }

  // The depth payload names the session; the quote carries the same field,
  // which is what remains when only the quote answered.
  const phaseValue = d?.marketSession ?? q?.marketSession
  const phase = typeof phaseValue === "string" ? phaseValue : null
  const phaseDescValue = d?.marketSessionDesc ?? q?.marketSessionDesc
  const session = phase ? (SESSION_BY_PHASE[phase] ?? null) : null

  const rows = Math.max(bids.length, asks.length)
  const merged = Array.from({ length: rows }, (_, i) => ({
    bidPx: bids[i]?.px ?? null,
    bidSz: bids[i]?.sz ?? 0,
    bidCt: 0, // The bridge does not carry per-level order counts.
    askPx: asks[i]?.px ?? null,
    askSz: asks[i]?.sz ?? 0,
    askCt: 0,
  }))

  const bestBid = bids[0]?.px ?? null
  const bestAsk = asks[0]?.px ?? null
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null
  const bidShares = bids.reduce((a, l) => a + l.sz, 0)
  const askShares = asks.reduce((a, l) => a + l.sz, 0)
  const total = bidShares + askShares

  return {
    venue: "XNAS",
    session,
    phase,
    phaseDesc: typeof phaseDescValue === "string" ? phaseDescValue : null,
    // A book is live only while a session is actually matching. Outside one the
    // endpoint serves the last resting post-market book, which must not be
    // presented as the current market.
    live: session != null,
    at: Date.now(),
    levels: merged,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps: spread != null && mid ? (spread / mid) * 10_000 : null,
    bidShares,
    askShares,
    bidNotional: bids.reduce((a, l) => a + l.sz * l.px, 0),
    askNotional: asks.reduce((a, l) => a + l.sz * l.px, 0),
    imbalancePct: total > 0 ? ((bidShares - askShares) / total) * 100 : null,
    last: q ? num(q.latestPrice) : null,
    // NOT `regularClose`. During regular hours the bridge reports that field as
    // the CURRENT close, equal to `latestPrice` — verified live at 1.750/1.750
    // while the day's actual previous close was 1.420. `raw.preClose` is the
    // previous close in every phase, and there is deliberately no fallback to
    // `regularClose`: falling back to the field this exists to avoid would
    // render a plausible, wrong +0.0% for a whole session. Null instead, and
    // the panel omits the change rather than inventing one.
    previousClose: q ? num(raw(q)?.preClose) : null,
    open: q ? num(raw(q)?.open) : null,
    high: q ? num(raw(q)?.high) : null,
    low: q ? num(raw(q)?.low) : null,
    // Null during regular hours, where there is no extended session to change
    // against. Reported as given rather than substituted.
    extendedChangePct: q ? num(q.extendedChangeRatio) : null,
    volume: q ? num(q.volume) : null,
    tradeTime: q && typeof q.tradeTime === "string" ? q.tradeTime : null,
    l1Only,
    ntvSize,
  }
}
