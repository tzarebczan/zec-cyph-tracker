"use client"

import { useId, useMemo, useState } from "react"
import useSWR from "swr"
import { CornerBox } from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactUSD, fmtPct, prettyPair, swrFetcher } from "./format"
import { ShareButton } from "./share-button"
import type {
  ZecExchangeAgg,
  ZecExchangesResponse,
  ZecMarketTicker,
} from "./api-types"

// ----------------------------------------------------------------------------
// Squarified treemap layout. Standard "strip" variant of the algorithm —
// pack items left-to-right (or top-to-bottom) along the SHORT axis of the
// remaining rectangle, finalising a row once adding the next item would
// degrade the worst aspect ratio. Output rectangles tile the parent
// container exactly with no overlap.
// ----------------------------------------------------------------------------

interface TreemapInput<T> {
  value: number
  data: T
}

interface TreemapRect<T> {
  x: number
  y: number
  w: number
  h: number
  data: T
}

function worstRatio(row: { value: number }[], shortSide: number): number {
  const sum = row.reduce((s, r) => s + r.value, 0)
  if (sum <= 0 || shortSide <= 0) return Infinity
  const max = Math.max(...row.map((r) => r.value))
  const min = Math.min(...row.map((r) => r.value))
  if (min <= 0 || max <= 0) return Infinity
  const s2 = shortSide * shortSide
  const sum2 = sum * sum
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min))
}

function squarify<T>(
  items: TreemapInput<T>[],
  width: number,
  height: number
): TreemapRect<T>[] {
  if (items.length === 0 || width <= 0 || height <= 0) return []
  const total = items.reduce((s, i) => s + i.value, 0)
  if (total <= 0) return []

  const sorted = [...items].sort((a, b) => b.value - a.value)
  // Scale every value so the entire item set sums to width*height (i.e.
  // the items now consume "pixel area" rather than abstract values).
  // From here on out we work entirely in scaled (pixel-area) units.
  const scale = (width * height) / total
  const scaled = sorted.map<TreemapInput<T>>((i) => ({
    value: i.value * scale,
    data: i.data,
  }))

  const result: TreemapRect<T>[] = []
  let rect = { x: 0, y: 0, w: width, h: height }
  let row: TreemapInput<T>[] = []
  let i = 0

  while (i < scaled.length) {
    const next = scaled[i]
    const shortSide = Math.min(rect.w, rect.h)
    const trial = [...row, next]
    if (row.length === 0 || worstRatio(trial, shortSide) <= worstRatio(row, shortSide)) {
      row = trial
      i++
      continue
    }
    rect = layoutRow(row, rect, result)
    row = []
  }
  if (row.length > 0) layoutRow(row, rect, result)
  return result
}

function layoutRow<T>(
  row: TreemapInput<T>[],
  rect: { x: number; y: number; w: number; h: number },
  result: TreemapRect<T>[]
): typeof rect {
  const sum = row.reduce((s, r) => s + r.value, 0)
  if (sum <= 0) return rect
  // Row sits on the LONG axis of the remaining rectangle; cells in the
  // row tile along the SHORT axis. The row's depth (perpendicular to
  // its length) is `sum / longSide`.
  const isHorizontal = rect.w >= rect.h
  if (isHorizontal) {
    const rowW = sum / rect.h
    let yPos = rect.y
    for (const r of row) {
      const cellH = r.value / rowW
      result.push({ x: rect.x, y: yPos, w: rowW, h: cellH, data: r.data })
      yPos += cellH
    }
    return { x: rect.x + rowW, y: rect.y, w: rect.w - rowW, h: rect.h }
  }
  const rowH = sum / rect.w
  let xPos = rect.x
  for (const r of row) {
    const cellW = r.value / rowH
    result.push({ x: xPos, y: rect.y, w: cellW, h: rowH, data: r.data })
    xPos += cellW
  }
  return { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH }
}

// ----------------------------------------------------------------------------
// Visual helpers
// ----------------------------------------------------------------------------

/** Choose SVG font sizes from the real tile box, not just its short
 *  side. Thin slivers skip labels entirely, avoiding the fuzzy text
 *  smears that happen when a long venue name is forced into a shard. */
function tileFont(w: number, h: number): { primary: number; secondary: number } | null {
  if (w < 78 || h < 34) return null
  if (w < 120 || h < 48) return { primary: 10, secondary: 0 }
  if (w < 180 || h < 66) return { primary: 12, secondary: 0 }
  return { primary: 14, secondary: 10 }
}

function fitTileLabel(label: string, maxWidth: number, fontSize: number): string {
  const maxChars = Math.floor(maxWidth / (fontSize * 0.64))
  if (maxChars < 4) return ""
  if (label.length <= maxChars) return label
  return `${label.slice(0, Math.max(1, maxChars - 3))}...`
}

// ----------------------------------------------------------------------------
// Treemap component
// ----------------------------------------------------------------------------

interface TreemapProps {
  exchanges: ZecExchangeAgg[]
  height: number
  /** Limit how many tiles to render. Tail venues collapse into the
   *  catch-all bottom rows of the layout; otherwise the bottom-right
   *  corner ends up filled with sub-pixel slivers nobody can read. */
  limit?: number
}

function ExchangeTreemap({ exchanges, height, limit = 18 }: TreemapProps) {
  const clipIdBase = useId().replace(/:/g, "")
  // Width is fixed via SVG viewBox + 100% width so the layout maths
  // here can stay in arbitrary units. We pick 1000 so percentage
  // rounding errors are imperceptible.
  const W = 1000
  const H = height
  const top = useMemo(() => {
    const items = exchanges
      .filter((e) => e.volumeUsd24h > 0)
    if (items.length <= limit) return items

    const head = items.slice(0, Math.max(1, limit - 1))
    const tail = items.slice(Math.max(1, limit - 1))
    return [
      ...head,
      {
        exchange: "Other venues",
        exchangeId: "__other_venues",
        exchangeLogo: null,
        volumeUsd24h: tail.reduce((sum, e) => sum + e.volumeUsd24h, 0),
        share: tail.reduce((sum, e) => sum + e.share, 0),
        marketCount: tail.reduce((sum, e) => sum + e.marketCount, 0),
        trustScore: null,
        volumeChange24h: null,
        volumeChangeWindowHours: null,
      },
    ]
  }, [exchanges, limit])

  const rects = useMemo(
    () =>
      squarify(
        top.map((e) => ({ value: e.volumeUsd24h, data: e })),
        W,
        H
      ),
    [top, H]
  )

  if (rects.length === 0) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: paletteVar("text"), opacity: 0.6 }}
      >
        No exchange data available.
      </div>
    )
  }

  const totalVol = top.reduce((s, e) => s + e.volumeUsd24h, 0)

  return (
    <svg
      role="img"
      aria-label="ZEC trading volume by exchange (treemap)"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      style={{ aspectRatio: `${W} / ${H}`, display: "block" }}
    >
      {rects.map((r, i) => {
        const ex = r.data
        // Intensity ramps with share, but the tile stays dark so text
        // remains readable even on the largest venues.
        const opacity = Math.min(0.42, 0.10 + Math.sqrt(ex.share) * 0.58)
        const font = tileFont(r.w, r.h)
        const clipId = `${clipIdBase}-tile-${i}`
        const label = font
          ? fitTileLabel(ex.exchange, Math.max(0, r.w - 20), font.primary)
          : ""
        const insetW = Math.max(0, r.w - 2)
        const insetH = Math.max(0, r.h - 2)
        return (
          <g key={ex.exchangeId}>
            <title>{`${ex.exchange} — ${fmtCompactUSD(ex.volumeUsd24h)} (${(ex.share * 100).toFixed(2)}%) · ${ex.marketCount} pair${ex.marketCount === 1 ? "" : "s"}`}</title>
            <clipPath id={clipId}>
              <rect
                x={r.x + 2}
                y={r.y + 2}
                width={Math.max(0, r.w - 4)}
                height={Math.max(0, r.h - 4)}
              />
            </clipPath>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill="#020403"
              stroke={paletteVar("zec")}
              strokeWidth={1}
              strokeOpacity={0.32}
              shapeRendering="crispEdges"
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={r.x + 1}
              y={r.y + 1}
              width={insetW}
              height={insetH}
              fill={paletteVar("zec")}
              fillOpacity={opacity}
              shapeRendering="crispEdges"
            />
            {font && label && (
              <>
                <text
                  clipPath={`url(#${clipId})`}
                  x={r.x + 10}
                  y={r.y + font.primary + 7}
                  fontSize={font.primary}
                  fontFamily="ui-monospace, monospace"
                  fontWeight={700}
                  fill="#f7fee7"
                  fillOpacity={0.96}
                  stroke="#000"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {label}
                </text>
                {font.secondary > 0 && r.h > font.primary + font.secondary + 12 && (
                  <text
                    clipPath={`url(#${clipId})`}
                    x={r.x + 10}
                    y={r.y + font.primary + font.secondary + 14}
                    fontSize={font.secondary}
                    fontFamily="ui-monospace, monospace"
                    fill={paletteVar("text")}
                    fillOpacity={0.82}
                    stroke="#000"
                    strokeWidth={2}
                    paintOrder="stroke"
                  >
                    {(ex.share * 100).toFixed(1)}%
                  </text>
                )}
              </>
            )}
          </g>
        )
      })}
      {/* Total-volume caption pinned to bottom-right corner. Helpful
          context for the heat-map but never overlaps a tile because
          its background is transparent. */}
      <text
        x={W - 8}
        y={H - 8}
        textAnchor="end"
        fontSize={9}
        fontFamily="ui-monospace, monospace"
        fill={paletteVar("text")}
        fillOpacity={0.5}
      >
        TOTAL: {fmtCompactUSD(totalVol)} - {top.length} TILES
      </text>
    </svg>
  )
}

// ----------------------------------------------------------------------------
// Top-pair share strip — secondary visualisation answering "where is the
// stablecoin/fiat/crypto routing concentrated?" without needing to scroll
// the per-venue table.
// ----------------------------------------------------------------------------

function PairShareStrip({
  pairs,
}: {
  pairs: ZecExchangesResponse["byPair"]
}) {
  const top = pairs.slice(0, 6)
  if (top.length === 0) return null
  return (
    <div className="flex h-6 w-full overflow-hidden border" style={{ borderColor: `${paletteVar("text")}33` }}>
      {top.map((p, i) => {
        // Cycle through the palette so adjacent stripes always contrast.
        // Pure rotation between cyph / zec / ratio mirrors the dashboard's
        // own visual language.
        const tint =
          i % 3 === 0
            ? paletteVar("zec")
            : i % 3 === 1
              ? paletteVar("cyph")
              : paletteVar("ratio")
        const label = prettyPair(p.pair)
        return (
          <div
            key={p.pair}
            title={`${p.pair} · ${fmtCompactUSD(p.volumeUsd24h)} (${(p.share * 100).toFixed(2)}%)`}
            style={{
              flexBasis: `${p.share * 100}%`,
              background: tint,
              opacity: 0.6,
              minWidth: p.share < 0.02 ? 0 : undefined,
            }}
            className="flex items-center justify-center text-[10px] font-bold tabular-nums text-black overflow-hidden whitespace-nowrap px-1"
          >
            {/* Only show the label if the cell is wide enough that the
                shortened name has a chance of fitting; the wrapper has
                overflow-hidden so a too-long label silently clips. */}
            {p.share >= 0.06 ? label : ""}
          </div>
        )
      })}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Main exported tab — composed of:
//  - 4-card stats header (TOTAL VOLUME / TOP EXCHANGE / # MARKETS / # VENUES)
//  - Heat-map treemap of the top-N venues by 24h volume
//  - Top trading pair share strip
//  - Per-venue table with logo, name, share %, volume, pair count
// ----------------------------------------------------------------------------

export function ExchangesTab() {
  const { data, error } = useSWR<ZecExchangesResponse>(
    "/api/zec-exchanges",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  const [showAll, setShowAll] = useState(false)

  const top = data?.byExchange ?? []
  const visible = showAll ? top : top.slice(0, 12)
  const top1 = top[0]

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ShareButton
          tweetText="$ZEC exchange stats — live venue share, 24h volume flow, and top trading pairs:"
          ogImagePath="/api/og/exchanges"
          pngFileName="zec-exchanges.png"
          shareUrl="https://cyphzec.com/exchanges"
          xCacheBust
          ariaLabel="Share ZEC exchange stats"
        />
      </div>

      {/* Stats header: 4 small cards summarising the distribution. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CornerBox label="TOTAL VOL · 24H" color={paletteVar("zec")}>
          <div
            className="text-2xl font-bold tabular-nums"
            style={{ color: paletteVar("zec"), textShadow: `0 0 6px ${paletteVar("zec")}55` }}
          >
            {fmtCompactUSD(data?.total24hVolumeUsd ?? null)}
          </div>
          <div className="text-[10px] mt-1" style={{ color: paletteVar("text"), opacity: 0.6 }}>
            across all venues
          </div>
        </CornerBox>
        <CornerBox label="TOP VENUE" color={paletteVar("zec")}>
          <div
            className="text-2xl font-bold tabular-nums truncate"
            style={{ color: paletteVar("zec"), textShadow: `0 0 6px ${paletteVar("zec")}55` }}
            title={top1?.exchange ?? "—"}
          >
            {top1?.exchange ?? "—"}
          </div>
          <div className="text-[10px] mt-1" style={{ color: paletteVar("text"), opacity: 0.6 }}>
            {top1
              ? `${(top1.share * 100).toFixed(1)}% · ${fmtCompactUSD(top1.volumeUsd24h)}`
              : "—"}
          </div>
        </CornerBox>
        <CornerBox label="MARKETS" color={paletteVar("zec")}>
          <div
            className="text-2xl font-bold tabular-nums"
            style={{ color: paletteVar("zec"), textShadow: `0 0 6px ${paletteVar("zec")}55` }}
          >
            {data?.marketCount ?? "—"}
          </div>
          <div className="text-[10px] mt-1" style={{ color: paletteVar("text"), opacity: 0.6 }}>
            distinct trading pairs
          </div>
        </CornerBox>
        <CornerBox label="EXCHANGES" color={paletteVar("zec")}>
          <div
            className="text-2xl font-bold tabular-nums"
            style={{ color: paletteVar("zec"), textShadow: `0 0 6px ${paletteVar("zec")}55` }}
          >
            {data?.exchangeCount ?? "—"}
          </div>
          <div className="text-[10px] mt-1" style={{ color: paletteVar("text"), opacity: 0.6 }}>
            unique venues
          </div>
        </CornerBox>
      </div>

      {/* Heat-map treemap. */}
      <CornerBox label="VOLUME HEAT-MAP · 24H" color={paletteVar("zec")}>
        {error ? (
          <div className="text-[11px]" style={{ color: paletteVar("text"), opacity: 0.7 }}>
            Couldn&apos;t load exchange data. Retrying…
          </div>
        ) : !data ? (
          <div className="text-[11px]" style={{ color: paletteVar("text"), opacity: 0.7 }}>
            Loading…
          </div>
        ) : (
          <div className="space-y-2">
            <ExchangeTreemap exchanges={data.byExchange} height={440} />
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] tracking-wider"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              <span>AREA = 24H USD VOLUME</span>
              <span>BRIGHTNESS = SHARE</span>
              <span className="ml-auto">24H EXCHANGE VOLUME</span>
            </div>
          </div>
        )}
      </CornerBox>

      {/* Top-pair share strip. */}
      {data && data.byPair.length > 0 && (
        <CornerBox label="TOP PAIRS · BY VOLUME" color={paletteVar("zec")}>
          <PairShareStrip pairs={data.byPair} />
          {/* Top-6 pair list under the share strip. Pair names can be
              very long (NEAR-wrapped EVM contracts can run 70+ chars);
              `prettyPair` collapses contract addresses + strips OMFT
              suffixes for the label, the full pair sits in `title` so
              hovering reveals the actual identifier, and `min-w-0 +
              truncate` keeps a stubborn 2-line wrap from blowing the
              row out of alignment with the rest of the column. */}
          <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-[11px] tabular-nums">
            {data.byPair.slice(0, 6).map((p) => (
              <div
                key={p.pair}
                className="flex items-baseline justify-between gap-2 min-w-0"
                style={{ color: paletteVar("text") }}
                title={p.pair}
              >
                <span
                  className="font-bold truncate min-w-0"
                  style={{ color: paletteVar("zec") }}
                >
                  {prettyPair(p.pair)}
                </span>
                <span className="shrink-0" style={{ opacity: 0.7 }}>
                  {fmtPct(p.share * 100, 1)} · {fmtCompactUSD(p.volumeUsd24h)}
                </span>
              </div>
            ))}
          </div>
        </CornerBox>
      )}

      {/* Per-venue table. Mirrors the rankings table styling so the
          /stats page reads consistently across the RANKINGS and
          EXCHANGES tabs. */}
      <CornerBox
        label={`VENUES · ${visible.length}/${top.length}`}
        color={paletteVar("zec")}
      >
        {/* Horizontal scroll wrapper. The 5-column grid totals ~360px
            min-width including gaps; on phones (<=480px viewport
            inside the CornerBox) the table can still overflow its parent.
            Wrapping in
            `overflow-x-auto` gives users a touch-scroll affordance
            without forcing a column-drop on mobile. The negative-
            margin trick lets the scroll area extend to the card's
            edges so the visual cue (clipped column) sits flush
            against the border, not against awkward inner padding. */}
        <div className="overflow-x-auto -mx-3 px-3">
          <div className="min-w-[360px]">
            {/* Header row. Column shape (5 cols):
                  # | EXCHANGE | SHARE | 24H VOL | Δ24H
                Δ24H sits next to 24H VOL so users read "vol changed by
                X%" as a single thought, vs putting it next to SHARE
                which would collide visually (two adjacent percent
                columns are hard to tell apart). */}
            <div className="grid grid-cols-[32px_1fr_68px_92px_72px] gap-x-3 gap-y-1 text-[11px] tracking-[0.15em] font-bold pb-1 border-b" style={{ borderColor: `${paletteVar("text")}33` }}>
              <span style={{ color: paletteVar("text"), opacity: 0.6 }}>#</span>
              <span style={{ color: paletteVar("text"), opacity: 0.6 }}>EXCHANGE</span>
              <span className="text-right" style={{ color: paletteVar("text"), opacity: 0.6 }}>SHARE</span>
              <span className="text-right" style={{ color: paletteVar("text"), opacity: 0.6 }}>24H VOL</span>
              <span className="text-right" style={{ color: paletteVar("text"), opacity: 0.6 }}>Δ24H</span>
            </div>
            {visible.map((ex, i) => {
              // Honest tooltip suffix based on the actual compare
              // window. During the first day after deploy, the ring
              // hasn't accumulated 24h of history yet — so the change
              // is computed against e.g. the 4h-old snapshot. Surface
              // that to the user instead of misleadingly labelling it
              // "vs prev day".
              const windowSuffix =
                ex.volumeChangeWindowHours == null
                  ? ""
                  : ex.volumeChangeWindowHours >= 22
                    ? "vs ~24h ago"
                    : `vs ~${Math.round(ex.volumeChangeWindowHours)}h ago`
              return (
                <div
                  key={ex.exchangeId}
                  className="grid grid-cols-[32px_1fr_68px_92px_72px] gap-x-3 items-center text-[11px] py-1.5 border-b"
                  style={{ borderColor: `${paletteVar("text")}11` }}
                >
                  <span
                    className="tabular-nums font-bold"
                    style={{ color: paletteVar("text"), opacity: 0.7 }}
                  >
                    {i + 1}
                  </span>
                  <span className="flex items-center gap-2 min-w-0">
                    {ex.exchangeLogo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={ex.exchangeLogo}
                        alt=""
                        width={16}
                        height={16}
                        className="shrink-0 rounded-sm"
                        loading="lazy"
                        style={{ objectFit: "contain" }}
                      />
                    )}
                    <span className="truncate" title={ex.exchange}>
                      {ex.exchange}
                    </span>
                  </span>
                  <span
                    className="text-right tabular-nums font-bold"
                    style={{ color: paletteVar("zec") }}
                  >
                    {(ex.share * 100).toFixed(2)}%
                  </span>
                  <span
                    className="text-right tabular-nums"
                    style={{ color: paletteVar("text") }}
                  >
                    {fmtCompactUSD(ex.volumeUsd24h)}
                  </span>
                  {/* Δ24H — change in this venue's rolling-24h volume
                      vs the reference snapshot picked from the KV ring.
                      Tooltip surfaces the actual window so users in the
                      first-day warm-up see e.g. "vs ~4h ago" not the
                      misleading "vs prev day". */}
                  <span
                    className="text-right tabular-nums"
                    title={
                      ex.volumeChange24h == null
                        ? "Volume change not yet available"
                        : `${ex.volumeChange24h >= 0 ? "+" : ""}${ex.volumeChange24h.toFixed(2)}% ${windowSuffix}`
                    }
                    style={{
                      color:
                        ex.volumeChange24h == null
                          ? paletteVar("text")
                          : ex.volumeChange24h >= 0
                            ? paletteVar("zec")
                            : E_STATIC.red,
                      opacity: ex.volumeChange24h == null ? 0.4 : 0.95,
                    }}
                  >
                    {ex.volumeChange24h == null
                      ? "—"
                      : `${ex.volumeChange24h >= 0 ? "+" : ""}${ex.volumeChange24h.toFixed(1)}%`}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        {top.length > 12 && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-[11px] px-3 py-1.5 border tracking-wider font-bold"
              style={{
                borderColor: `${paletteVar("zec")}55`,
                color: paletteVar("zec"),
                background: `${paletteVar("zec")}11`,
              }}
            >
              {showAll ? "SHOW LESS" : `SHOW ALL ${top.length}`}
            </button>
          </div>
        )}
        {data?.stale && (
          <div
            className="mt-2 text-[10px] tracking-wider"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            CACHED · CoinGecko upstream temporarily unavailable, last-known-good shown.
          </div>
        )}
      </CornerBox>
    </div>
  )
}

// Re-export types so callers can import them from a single module if
// they need to render bits of the data outside this file (e.g. the
// dashboard's at-a-glance strip already imports `ZecExchangeAgg` from
// api-types directly, but exposing the row type here lets future
// consumers grab everything from one place).
export type { ZecExchangeAgg, ZecMarketTicker }
