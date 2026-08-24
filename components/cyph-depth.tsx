"use client"

import { useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { CornerBox, ETabs, InfoTip, Skeleton } from "./primitives"
import { paletteVar, withAlpha, E_STATIC } from "./theme"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { useMarketSession } from "./market-clock"
import { useCyphFlow } from "./cyph-flow"
import { sessionName } from "@/lib/market-session"
import type { CyphDepthBook, CyphDepthResponse } from "./api-types"

// CYPH depth of book. Everything here is the LAST COMPLETED session, never a
// live book — the upstream embargoes equity depth for 24 hours (see
// /api/cyph-depth). That is stated on every surface rather than in a footnote,
// because a book that looks live and isn't is worse than no book: the whole
// point of a depth chart is what you could trade against right now.

const BID = () => paletteVar("cyph")
const ASK = () => E_STATIC.red

/** The payload only changes once a day, so this polls slowly and exists
 *  mainly to pick up the new session after a publish. */
const POLL_MS = 10 * 60_000

const SESSION_ORDER = ["OVERNIGHT", "PRE", "REGULAR", "AFTER"] as const
type DepthSessionId = (typeof SESSION_ORDER)[number]

const SESSION_LABEL: Record<DepthSessionId, string> = {
  OVERNIGHT: "OVN",
  PRE: "PRE",
  REGULAR: "REG",
  AFTER: "AFT",
}

const VENUE_NAME: Record<CyphDepthBook["venue"], string> = {
  XNAS: "Nasdaq",
  OCEA: "Blue Ocean ATS",
}

export function useCyphDepth() {
  const visible = usePageVisible()
  return useSWR<CyphDepthResponse>("/api/cyph-depth", swrFetcher, {
    refreshInterval: visible ? POLL_MS : 0,
    keepPreviousData: true,
  })
}

/** The server's own explanation, when it gave one. `swrFetcher` throws with
 *  the response body's `error` field as the message, so this is the route's
 *  wording — including its `needsKey` line — rather than a guess at the
 *  cause. Anything unrecognisable is dropped in favour of the caller's
 *  generic text; an internal message is not worth showing a reader. */
function errorText(err: unknown): string | null {
  const msg = err instanceof Error ? err.message.trim() : ""
  if (!msg || msg.length > 120) return null
  return /^[\w\s.,'’:/()-]+$/.test(msg) ? msg : null
}

function fmtSessionDate(iso: string): string {
  // `iso` is a bare ET calendar date. Parsing it as a Date would drag the
  // viewer's timezone in and can render the day before, so format the parts.
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d) return iso
  const month = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ][m - 1]
  return `${month} ${d}`
}

function fmtPx(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(2)}`
}

/** Shared "this is not live" caption. Names the session the book is from and
 *  what is trading right now, so the two are never confused. */
function NotLiveNote({
  date,
  compact = false,
}: {
  date: string
  compact?: boolean
}) {
  const state = useMarketSession()
  const live = state?.current
    ? `${sessionName(state.current.session)} is trading now`
    : "Market closed now"
  return (
    <span
      className={compact ? "text-[9px] tracking-[0.12em]" : "text-[10px] tracking-[0.12em]"}
      style={{ color: paletteVar("text"), opacity: 0.5 }}
    >
      {live} · book is {fmtSessionDate(date)} close
    </span>
  )
}

/** Live top-of-book from Nasdaq, shown beside the historical ten-level book.
 *  Deliberately separate from the book rather than merged into it: this is one
 *  level and current, that one is ten levels and hours old, and averaging the
 *  two labels into something vague would misrepresent both. Renders nothing
 *  unless Nasdaq asserts the quote is real time — outside a session the same
 *  fields describe the previous close, which must not read as live. */
function Level1Row({ compact = false }: { compact?: boolean }) {
  const { data } = useCyphFlow()
  const l1 = data?.level1
  if (!l1 || !l1.isRealTime || data?.stale) return null
  if (l1.bid == null && l1.ask == null) return null
  const sz = (n: number | null) => (n == null ? "" : ` \u00d7${fmtCompactNumber(n)}`)
  return (
    <div
      className={`flex items-baseline justify-between gap-2 tabular-nums ${compact ? "text-[9px]" : "text-[10px]"}`}
      title={`Live top of book from Nasdaq${l1.asOf ? ` \u00b7 ${l1.asOf}` : ""}`}
    >
      <span className="tracking-[0.15em] shrink-0" style={{ color: paletteVar("cyph") }}>
        LIVE
      </span>
      <span className="min-w-0 truncate text-right">
        <span style={{ color: BID() }}>
          {l1.bid == null ? "\u2014" : `$${l1.bid.toFixed(2)}`}
          {sz(l1.bidSize)}
        </span>
        <span style={{ color: paletteVar("text"), opacity: 0.4 }}>{" / "}</span>
        <span style={{ color: ASK() }}>
          {l1.ask == null ? "\u2014" : `$${l1.ask.toFixed(2)}`}
          {sz(l1.askSize)}
        </span>
      </span>
    </div>
  )
}

/** Bid-vs-ask split of the resting size across the ten visible levels. */
function ImbalanceBar({ book }: { book: CyphDepthBook }) {
  const total = book.bidShares + book.askShares
  const bidPct = total > 0 ? (book.bidShares / total) * 100 : 50
  return (
    <div className="flex h-[6px] w-full overflow-hidden" title={
      `${book.bidShares.toLocaleString()} shares bid vs ${book.askShares.toLocaleString()} offered across the ten visible levels`
    }>
      <div style={{ width: `${bidPct}%`, background: withAlpha(BID(), 85) }} />
      <div style={{ width: `${100 - bidPct}%`, background: withAlpha(ASK(), 85) }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// CyphDepthStrip — the CYPH tile's opt-in depth row.
// ---------------------------------------------------------------------------

export function CyphDepthStrip() {
  const { data, error } = useCyphDepth()

  if (!data) {
    return (
      <div className="mt-3 space-y-1.5" aria-busy="true">
        {error ? (
          <div
            className="text-[9px] tracking-[0.15em]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            DEPTH FEED UNAVAILABLE
          </div>
        ) : (
          <>
            <Skeleton height={8} />
            <Skeleton height={26} />
          </>
        )}
      </div>
    )
  }

  // Prefer the latest session of the day for the strip — it is the closest
  // thing to "where the book left off".
  const book = [...data.sessions].sort(
    (a, b) => SESSION_ORDER.indexOf(b.session) - SESSION_ORDER.indexOf(a.session)
  )[0]
  if (!book) return null

  return (
    // The strip IS the link, mirroring the ZEC tile's depth strip: `z-[2]`
    // beats the tile's own stretched overlay, which points at a bare
    // /holdings and would otherwise land a reader on whichever treasury group
    // they last had selected rather than on the book they just clicked.
    <Link
      href="/holdings?view=book"
      className="relative z-[2] mt-3 block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
      style={{ outlineColor: paletteVar("cyph") }}
      title="Open the CYPH order book"
    >
      <div className="flex items-baseline justify-between gap-2 text-[9px] tracking-[0.15em]">
        <span style={{ color: paletteVar("cyph"), opacity: 0.8 }}>
          {SESSION_LABEL[book.session]} BOOK
        </span>
        <span className="tabular-nums" style={{ color: paletteVar("text"), opacity: 0.65 }}>
          {fmtPx(book.bestBid)} / {fmtPx(book.bestAsk)}
        </span>
      </div>
      {/* The curve, not a flat proportional bar: the ZEC tile's strip shows a
          mirrored depth curve at this exact height, and a split bar beside it
          read as a different kind of readout rather than the same one for a
          different asset. The curve also shows WHERE the size sits, which on a
          ten-level book is the interesting part — the split is still legible
          from the areas, and the numbers below carry it exactly. */}
      <DepthCurve
        book={book}
        height={34}
        showAxis={false}
        fallback={
          <div className="mt-1">
            <ImbalanceBar book={book} />
          </div>
        }
      />
      <div className="mt-1">
        <Level1Row compact />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[9px] tabular-nums">
        <span style={{ color: BID() }}>{fmtCompactNumber(book.bidShares)} BID</span>
        <span style={{ color: paletteVar("text"), opacity: 0.5 }}>
          {book.spread != null ? `$${book.spread.toFixed(2)} SPR` : "—"}
        </span>
        <span style={{ color: ASK() }}>{fmtCompactNumber(book.askShares)} ASK</span>
      </div>
      <div className="mt-1">
        <NotLiveNote date={data.sessionDate} compact />
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Ladder — the ten levels, bids mirrored left and asks right of the mid.
// ---------------------------------------------------------------------------

function Ladder({ book }: { book: CyphDepthBook }) {
  // Bars are scaled to the single largest resting size on either side, so the
  // two halves stay directly comparable. Scaling each side to its own max
  // would make a thin bid look as deep as a thick offer.
  const peak = useMemo(
    () =>
      book.levels.reduce(
        (m, l) => Math.max(m, l.bidPx != null ? l.bidSz : 0, l.askPx != null ? l.askSz : 0),
        0
      ),
    [book]
  )
  const width = (sz: number, present: boolean) =>
    present && peak > 0 ? `${Math.max((sz / peak) * 100, 1.5)}%` : "0%"

  return (
    <div className="mt-2 space-y-px">
      <div
        className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-x-2 text-[9px] tracking-[0.14em] pb-1"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        <span className="text-right">BID SIZE</span>
        <span className="text-right tabular-nums w-[52px]">BID</span>
        <span className="text-center w-[18px]" />
        <span className="text-left tabular-nums w-[52px]">ASK</span>
        <span>ASK SIZE</span>
      </div>
      {book.levels.map((l, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-x-2 text-[10px]"
        >
          {/* Bid size bar, grown right-to-left so both sides meet at the mid. */}
          <div className="flex justify-end items-center gap-1 min-w-0">
            <span
              className="tabular-nums shrink-0"
              style={{ color: paletteVar("text"), opacity: l.bidPx != null ? 0.75 : 0.25 }}
            >
              {l.bidPx != null ? l.bidSz.toLocaleString() : "—"}
            </span>
            <div className="h-[9px] flex-1 min-w-0 flex justify-end">
              <div
                style={{ width: width(l.bidSz, l.bidPx != null), background: withAlpha(BID(), 55) }}
              />
            </div>
          </div>
          <span
            className="tabular-nums text-right w-[52px]"
            style={{ color: l.bidPx != null ? BID() : paletteVar("text"), opacity: l.bidPx != null ? 1 : 0.25 }}
          >
            {l.bidPx != null ? l.bidPx.toFixed(2) : "—"}
          </span>
          <span
            className="text-center w-[18px] text-[9px] tabular-nums"
            style={{ color: paletteVar("text"), opacity: 0.3 }}
          >
            {i + 1}
          </span>
          <span
            className="tabular-nums text-left w-[52px]"
            style={{ color: l.askPx != null ? ASK() : paletteVar("text"), opacity: l.askPx != null ? 1 : 0.25 }}
          >
            {l.askPx != null ? l.askPx.toFixed(2) : "—"}
          </span>
          <div className="flex items-center gap-1 min-w-0">
            <div className="h-[9px] flex-1 min-w-0 flex">
              <div
                style={{ width: width(l.askSz, l.askPx != null), background: withAlpha(ASK(), 55) }}
              />
            </div>
            <span
              className="tabular-nums shrink-0"
              style={{ color: paletteVar("text"), opacity: l.askPx != null ? 0.75 : 0.25 }}
            >
              {l.askPx != null ? l.askSz.toLocaleString() : "—"}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Mirrored cumulative depth — the classic depth-chart shape. Bids run left
 *  from the mid and asks right, each plotted as the cumulative shares resting
 *  at or inside that price.
 *
 *  The x axis is price, not level index, so a level three cents away sits
 *  three cents away: on a book this sparse the gaps between levels are the
 *  interesting part, and an index axis would hide them by spacing every level
 *  evenly. Both sides share one y scale so the taller wall is visibly the
 *  taller wall. */
function DepthCurve({
  book,
  height = 92,
  showAxis = true,
  live,
  fallback,
}: {
  book: CyphDepthBook
  /** 34 in the tile strip, matching the ZEC tile's curve; 92 in the card. */
  height?: number
  /** The price axis under the curve. Suppressed in the strip, where the touch
   *  is already on the row above and three more numbers would crowd it. */
  showAxis?: boolean
  /** Live inside market to mark on the curve, when there is one. The curve
   *  itself is the last published session's resting depth and is hours old;
   *  these two ticks are current. Showing them together is the point — you can
   *  read where the market is now against the size that was resting. Marks
   *  outside the curve's price window are dropped rather than clamped, since a
   *  clamped tick would assert a price the market is not at. */
  live?: { bid: number | null; ask: number | null } | null
  /** Drawn instead of the curve when the book has no drawable geometry — no
   *  mid, or every level resting at zero size. The route accepts such a book
   *  (it only rejects one with no prices at all), so this is a real state and
   *  not a defensive branch. Taking it here rather than testing a predicate at
   *  each call site keeps the "is it drawable" question in the one place that
   *  actually answers it. */
  fallback?: ReactNode
}) {
  const geom = useMemo(() => {
    const mid = book.mid
    if (mid == null) return null

    // Cumulative steps outward from the mid on each side.
    const bids: { px: number; cum: number }[] = []
    const asks: { px: number; cum: number }[] = []
    let bc = 0
    let ac = 0
    for (const l of book.levels) {
      if (l.bidPx != null && l.bidSz > 0) {
        bc += l.bidSz
        bids.push({ px: l.bidPx, cum: bc })
      }
      if (l.askPx != null && l.askSz > 0) {
        ac += l.askSz
        asks.push({ px: l.askPx, cum: ac })
      }
    }
    if (bids.length === 0 && asks.length === 0) return null

    // Symmetric x window so the mid sits dead centre and the two sides are
    // directly comparable. Driven by whichever side reaches further.
    const reach = Math.max(
      ...bids.map((b) => mid - b.px),
      ...asks.map((a) => a.px - mid),
      0.01
    )
    const peak = Math.max(bc, ac, 1)
    const W = 100
    const H = 100
    const x = (px: number) => ((px - (mid - reach)) / (2 * reach)) * W
    const y = (cum: number) => H - (cum / peak) * H

    // Stepped path: a resting level is flat until the next price is reached,
    // which is what the book actually is — not a smooth curve.
    const path = (pts: { px: number; cum: number }[]) => {
      if (pts.length === 0) return null
      const d: string[] = [`M ${x(mid).toFixed(2)} ${H}`]
      let prevY = H
      for (const p of pts) {
        d.push(`L ${x(p.px).toFixed(2)} ${prevY.toFixed(2)}`)
        prevY = y(p.cum)
        d.push(`L ${x(p.px).toFixed(2)} ${prevY.toFixed(2)}`)
      }
      // Close down to the baseline under the outermost level. Both sides walk
      // outward from the mid, so this is the same expression either way.
      d.push(`L ${x(pts[pts.length - 1].px).toFixed(2)} ${H}`, "Z")
      return d.join(" ")
    }

    return {
      bidPath: path(bids),
      askPath: path(asks),
      midX: x(mid),
      lo: mid - reach,
      hi: mid + reach,
      peak,
    }
  }, [book])

  if (!geom) return <>{fallback}</>
  return (
    <div className="mt-3">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height }}
        role="img"
        aria-label={`Cumulative resting depth around a mid of ${book.mid?.toFixed(2)}`}
      >
        {geom.bidPath && (
          <path d={geom.bidPath} fill={withAlpha(BID(), 30)} stroke={BID()} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        )}
        {([
          ["bid", live?.bid, BID()] as const,
          ["ask", live?.ask, ASK()] as const,
        ]).map(([side, px, colour]) =>
          px == null || px < geom.lo || px > geom.hi ? null : (
            <line
              key={side}
              x1={((px - geom.lo) / (geom.hi - geom.lo)) * 100}
              x2={((px - geom.lo) / (geom.hi - geom.lo)) * 100}
              y1={0}
              y2={100}
              stroke={colour}
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
          )
        )}
        {geom.askPath && (
          <path d={geom.askPath} fill={withAlpha(ASK(), 30)} stroke={ASK()} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        )}
        <line
          x1={geom.midX}
          x2={geom.midX}
          y1={0}
          y2={100}
          stroke={paletteVar("text")}
          strokeWidth={0.5}
          strokeDasharray="2 2"
          opacity={0.35}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {showAxis && (
        <div
          className="flex items-baseline justify-between text-[9px] tabular-nums"
          style={{ color: paletteVar("text"), opacity: 0.45 }}
        >
          <span>${geom.lo.toFixed(2)}</span>
          <span>mid ${book.mid?.toFixed(2)}</span>
          <span>${geom.hi.toFixed(2)}</span>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  color,
  tip,
}: {
  label: string
  value: string
  color?: string
  tip?: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[9px] tracking-[0.16em] leading-none">
        <span style={{ color: paletteVar("text"), opacity: 0.65 }}>{label}</span>
        {tip && (
          <InfoTip label={label} align="center">
            {tip}
          </InfoTip>
        )}
      </div>
      <div
        className="mt-1 text-[13px] font-bold tabular-nums leading-none truncate"
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CyphDepthPanel — the full per-session book. Used by /holdings → DEPTH.
// ---------------------------------------------------------------------------

export function CyphDepthPanel({ className }: { className?: string }) {
  const { data, error } = useCyphDepth()
  const [picked, setPicked] = useState<DepthSessionId | null>(null)

  const sessions = useMemo(
    () =>
      [...(data?.sessions ?? [])].sort(
        (a, b) => SESSION_ORDER.indexOf(a.session) - SESSION_ORDER.indexOf(b.session)
      ),
    [data]
  )
  // Open on the session that is actually trading — during pre-market that is
  // PRE, not whichever session happens to sit last in the day's set. Falls
  // back to the last session when nothing is trading (overnight into a
  // weekend) or when the live session has not published a book yet, and a
  // stored pick that is not in this day's set is discarded rather than
  // stranding the reader on an empty tab (a holiday closes no pre or regular
  // session, so yesterday's choice can vanish).
  const live = useMarketSession()?.current?.session ?? null
  // Only mark the curve while Nasdaq asserts the quote is real time — the same
  // gate Level1Row applies, so the ticks and the numbers never disagree.
  const flow = useCyphFlow().data
  const live1 =
    flow?.level1 && flow.level1.isRealTime && !flow.stale ? flow.level1 : null
  const active =
    sessions.find((s) => s.session === picked)?.session ??
    sessions.find((s) => s.session === live)?.session ??
    sessions[sessions.length - 1]?.session ??
    null
  const book = sessions.find((s) => s.session === active) ?? null

  if (!data) {
    return (
      <CornerBox label="ORDER BOOK" color={paletteVar("cyph")} className={className}>
        {error ? (
          <div
            className="text-[11px] py-8 text-center"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            {/* The server says why. Naming the binding unconditionally, as
                this did, told readers their secret was missing whenever the
                feed hiccuped for any other reason — which is exactly what it
                claimed during an outage caused by a session-planning bug,
                with the binding present and the upstream healthy. */}
            {errorText(error) ?? "Depth feed unavailable."}
          </div>
        ) : (
          <Skeleton className="mt-2" height={260} />
        )}
      </CornerBox>
    )
  }

  return (
    <CornerBox
      label="ORDER BOOK"
      color={paletteVar("cyph")}
      className={className}
      action={
        <span className="flex flex-wrap items-center gap-2 justify-end">
          {/* Not-live badge sits in the header, not the footer: it qualifies
              every number in the card. */}
          <span
            className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.12em] whitespace-nowrap"
            style={{
              borderColor: withAlpha(paletteVar("amber"), 85),
              color: paletteVar("amber"),
              background: withAlpha(paletteVar("amber"), 12),
            }}
            title="Equity depth of book is published 24 hours in arrears, so this is the last completed session's closing book — not a live book."
          >
            NOT LIVE · {fmtSessionDate(data.sessionDate)} CLOSE
          </span>
          {sessions.length > 1 && (
            <ETabs
              items={sessions.map(
                (s) => [s.session, SESSION_LABEL[s.session]] as const
              )}
              active={active as DepthSessionId}
              onChange={setPicked}
              compact
            />
          )}
        </span>
      }
    >
      {!book ? (
        <div
          className="text-[11px] py-8 text-center"
          style={{ color: paletteVar("text"), opacity: 0.5 }}
        >
          No resting book published for this session.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-1">
            <Stat label="BID" value={fmtPx(book.bestBid)} color={BID()} />
            <Stat label="ASK" value={fmtPx(book.bestAsk)} color={ASK()} />
            <Stat
              label="SPREAD"
              value={
                book.spread == null
                  ? "—"
                  : `$${book.spread.toFixed(2)}${
                      book.spreadBps != null ? ` · ${Math.round(book.spreadBps)}bp` : ""
                    }`
              }
              tip="Best ask minus best bid at the session close, and the same gap as a fraction of the mid. A wide spread on a thin book means the quoted price is further from what you would actually pay."
            />
            <Stat
              label="IMBALANCE"
              value={
                book.imbalancePct == null
                  ? "—"
                  : `${book.imbalancePct > 0 ? "+" : ""}${book.imbalancePct.toFixed(0)}%`
              }
              color={
                book.imbalancePct == null
                  ? undefined
                  : book.imbalancePct >= 0
                    ? BID()
                    : ASK()
              }
              tip="Resting shares bid minus offered, over their total, across the ten visible levels. Positive means more size waiting to buy than to sell — at this horizon only, not the whole book."
            />
          </div>

          <div className="mt-3">
            <ImbalanceBar book={book} />
            <div className="mt-1 flex items-baseline justify-between text-[10px] tabular-nums">
              <span style={{ color: BID() }}>
                {book.bidShares.toLocaleString()} sh · {fmtCompactUSD(book.bidNotional)}
              </span>
              <span style={{ color: ASK() }}>
                {fmtCompactUSD(book.askNotional)} · {book.askShares.toLocaleString()} sh
              </span>
            </div>
          </div>

          {/* The delayed book and the live quote, read together: the curve is
              the last published session's resting depth, the dashed ticks are
              where the inside market is right now. */}
          <DepthCurve book={book} live={live1} />

          <div className="mt-2">
            <Level1Row />
          </div>

          <Ladder book={book} />

          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <NotLiveNote date={data.sessionDate} />
            <span
              className="text-[10px] tracking-[0.12em]"
              style={{ color: paletteVar("text"), opacity: 0.4 }}
            >
              {sessionName(book.session)} on {VENUE_NAME[book.venue]} ·{" "}
              {/* Three states, not two. A day in progress is normally
                  incomplete because its later sessions have not published
                  yet, and calling that "a feed is down" cried wolf on the
                  ordinary case. `?? 0` guards a payload cached before this
                  field existed. */}
              {data.complete
                ? `${sessions.length} of ${data.sessionsTotal} sessions held a book`
                : (data.pending ?? 0) > 0
                  ? `${sessions.length} of ${data.sessionsTotal} sessions · ${data.pending} still to publish`
                  : `${sessions.length}/${data.sessionsTotal} sessions · a feed is down, retrying`}
            </span>
          </div>
        </>
      )}
    </CornerBox>
  )
}
