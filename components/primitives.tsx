"use client"

import {
  type CSSProperties,
  type ReactNode,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import Link from "next/link"
import { Link2 } from "lucide-react"
import { usePageVisible } from "@/hooks/use-page-visible"
import { useFlashOnChange } from "@/lib/use-flash-on-change"
import { paletteVar, E_STATIC, DEFAULT_PALETTE } from "./theme"

// ──────────────────────────────────────────────────────────────────────
// Skeleton — pulsing block-coloured placeholder for loading regions.
// Sized via inline width/height (so callers can match the eventual
// content's footprint) and tinted via CSS variable so palette swaps
// apply. Respects motion=off + reduced-motion (still visible, just
// doesn't pulse).
// ──────────────────────────────────────────────────────────────────────
export function Skeleton({
  width,
  height,
  className = "",
  style,
}: {
  width?: number | string
  height?: number | string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      className={`cz-skeleton inline-block ${className}`}
      style={{
        width: width ?? "100%",
        height: height ?? "1em",
        ...style,
      }}
    />
  )
}

// ──────────────────────────────────────────────────────────────────────
// useChartDrawIn — bundles the stroke-dasharray draw-in animation
// the old design used to load every chart line left-to-right with.
// Caller passes a ref to a <path>; the hook attaches the animation
// on mount + whenever path.d changes (period switch, new data),
// gated on `motion=off` via the document-root attribute so the
// Settings preference + prefers-reduced-motion both turn it off.
// Returns nothing — it's all imperative DOM mutation.
// ──────────────────────────────────────────────────────────────────────
export function useChartDrawIn(
  pathRef: React.MutableRefObject<SVGPathElement | null>,
  pathD: string,
  duration = 900
) {
  useEffect(() => {
    const el = pathRef.current
    if (!el || !pathD) return
    if (typeof document !== "undefined") {
      // Respect user's motion preference. data-cz-motion="off" comes
      // from useCyphzecSettings applySettings().
      const motion = document.documentElement.dataset.czMotion
      const prefersReduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      if (motion === "off" || prefersReduced) {
        // Skip animation entirely — render the line in full.
        el.style.strokeDasharray = "none"
        el.style.strokeDashoffset = "0"
        el.style.transition = "none"
        return
      }
    }
    const len = el.getTotalLength()
    if (!Number.isFinite(len) || len === 0) return
    el.style.strokeDasharray = String(len)
    el.style.strokeDashoffset = String(len)
    el.style.transition = "none"
    // Force a reflow so the offset transition actually triggers.
    void el.getBoundingClientRect()
    el.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`
    requestAnimationFrame(() => {
      if (pathRef.current) pathRef.current.style.strokeDashoffset = "0"
    })
  }, [pathRef, pathD, duration])
}

// ──────────────────────────────────────────────────────────────────────
// useIsMobile — true when the viewport is below Tailwind's `md`
// breakpoint (768px). Lets chart consumers pick a narrower viewBox
// width on mobile so SVG text doesn't get horizontally squished.
// ──────────────────────────────────────────────────────────────────────
export function useIsMobile(): boolean {
  const [is, setIs] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(max-width: 767px)")
    setIs(mq.matches)
    const onChange = () => setIs(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return is
}

// ──────────────────────────────────────────────────────────────────────
// WindowChips — terminal-styled radio button row for chart-window
// selection (1D / 7D / 30D / 90D / ALL). Used on every history chart
// in the app so the affordance + visual reads the same everywhere.
// `available` lets callers grey out windows that have no data yet
// (e.g. ALL when an endpoint hasn't backfilled history).
// ──────────────────────────────────────────────────────────────────────
export type ChartWindow = "1D" | "7D" | "30D" | "90D" | "1Y" | "ALL"

export const DEFAULT_WINDOWS: ChartWindow[] = ["7D", "30D", "90D", "ALL"]
export const DAILY_WINDOWS: ChartWindow[] = ["7D", "30D", "90D", "1Y", "ALL"]
export const INTRADAY_AND_DAILY_WINDOWS: ChartWindow[] = [
  "1D",
  "7D",
  "30D",
  "90D",
  "ALL",
]

/** Map a ChartWindow to a number of days for slicing. ALL returns
 *  null — the caller should use the full series. 1D returns 1 (which
 *  on daily-resolution charts only yields a single point; the chart
 *  shows an em-dash placeholder in that case). 1Y returns 365. */
export function windowSliceDays(w: ChartWindow): number | null {
  switch (w) {
    case "1D":
      return 1
    case "7D":
      return 7
    case "30D":
      return 30
    case "90D":
      return 90
    case "1Y":
      return 365
    case "ALL":
      return null
  }
}

export function WindowChips({
  value,
  onChange,
  options = DEFAULT_WINDOWS,
  color,
}: {
  value: ChartWindow
  onChange: (v: ChartWindow) => void
  options?: ChartWindow[]
  color?: string
}) {
  const c = color ?? paletteVar("cyph")
  return (
    <span className="inline-flex items-center gap-px">
      {options.map((w) => {
        const on = value === w
        return (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            aria-pressed={on}
            className="border px-2 py-0.5 text-[11px] tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: on ? c : paletteVar("text"),
              opacity: on ? 1 : 0.7,
              // Inactive chips carry a faint border so they read as
              // tappable; active state lifts the border to the
              // foreground colour for a clear toggle affordance.
              background: on ? `${c}1a` : "rgba(255,255,255,0.02)",
              borderColor: on ? c : `${paletteVar("text")}33`,
              outlineColor: c,
            }}
          >
            {w}
          </button>
        )
      })}
    </span>
  )
}

// ──────────────────────────────────────────────────────────────────────
// CoinLogo — cryptocurrency icon with a letter-monogram fallback when
// the upstream image URL is null or 404s. Matches the legacy stats
// page's `CoinLogo`; both render at the same size + monogram so the
// fallback feels deliberate rather than broken. Used in the rankings
// table + rank-neighbor mini-table.
// ──────────────────────────────────────────────────────────────────────
export function CoinLogo({
  image,
  symbol,
  size = 18,
}: {
  image: string | null | undefined
  symbol: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  if (!image || broken) {
    // Monogram fallback. role=img + aria-label so screen readers get
    // the ticker symbol, since the visual ("BT") is a truncation that
    // doesn't read as "Bitcoin" on its own.
    return (
      <span
        role="img"
        aria-label={`${symbol} logo`}
        className="inline-flex items-center justify-center flex-shrink-0 font-mono font-bold"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.45)),
          border: `1px solid ${paletteVar("text")}44`,
          color: paletteVar("text"),
          background: "rgba(0,0,0,0.4)",
        }}
      >
        {symbol.slice(0, 2)}
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt={`${symbol} logo`}
      width={size}
      height={size}
      className="rounded-full flex-shrink-0"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  )
}

// ──────────────────────────────────────────────────────────────────────
// CRT overlay (scanlines + grid + vignette). Visibility is driven from
// html[data-cz-bg] / data-cz-vignette via beta.css so user settings
// flip them without unmounting the component.
// ──────────────────────────────────────────────────────────────────────
const CRT_LAYER_STYLE = { contain: "paint" as const }

export function CRT() {
  return (
    <>
      <div
        aria-hidden="true"
        className="cz-scanlines absolute inset-0 pointer-events-none z-[1]"
        style={{
          ...CRT_LAYER_STYLE,
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(134,239,172,0.04) 0px, rgba(134,239,172,0.04) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <div
        aria-hidden="true"
        className="cz-grid absolute inset-0 pointer-events-none z-[1]"
        style={{
          ...CRT_LAYER_STYLE,
          backgroundImage:
            "linear-gradient(rgba(134,239,172,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(134,239,172,0.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage:
            "radial-gradient(ellipse at center, black 40%, transparent 85%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 40%, transparent 85%)",
        }}
      />
      <div
        aria-hidden="true"
        className="cz-vignette absolute inset-0 pointer-events-none z-[1]"
        style={{
          ...CRT_LAYER_STYLE,
          background:
            "radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.5) 100%)",
        }}
      />
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────
// LED — pulsing phosphor dot. Used in the header + LIVE badges.
// ──────────────────────────────────────────────────────────────────────
export function LED({ color, size = 6 }: { color?: string; size?: number }) {
  const c = color ?? paletteVar("cyph")
  return (
    <span
      aria-hidden="true"
      className="cz-led-pulse inline-block rounded-full align-middle"
      style={{
        width: size,
        height: size,
        background: c,
        boxShadow: `0 0 8px ${c}, 0 0 2px ${c}`,
      }}
    />
  )
}

// ──────────────────────────────────────────────────────────────────────
// Brand mark — "CYPH ⟁ ZEC" with a small phosphor split-bar glyph.
// ──────────────────────────────────────────────────────────────────────
export function Brand({
  size = 12,
  className = "",
  onClick,
  ariaLabel,
}: {
  size?: number
  className?: string
  onClick?: () => void
  ariaLabel?: string
}) {
  const inner = (
    <>
      <span style={{ color: paletteVar("cyph") }}>CYPH</span>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          verticalAlign: "middle",
          width: size * 1.0,
          height: Math.max(2, size * 0.45),
          borderRadius: 1,
          background: `linear-gradient(90deg, ${paletteVar("cyph")} 0 50%, ${paletteVar("zec")} 50% 100%)`,
          boxShadow: `0 0 5px ${paletteVar("cyph")}88, 0 0 5px ${paletteVar("zec")}66`,
        }}
      />
      <span style={{ color: paletteVar("zec") }}>ZEC</span>
    </>
  )
  const styles: CSSProperties = {
    fontSize: size,
    color: paletteVar("text"),
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? "Home"}
        className={`inline-flex items-center gap-1.5 font-bold tracking-[0.2em] transition-opacity hover:opacity-80 ${className}`}
        style={styles}
      >
        {inner}
      </button>
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-bold tracking-[0.2em] ${className}`}
      style={styles}
    >
      {inner}
    </span>
  )
}

// ──────────────────────────────────────────────────────────────────────
// CornerBox — ASCII bracket frame around content. `interactive` brightens
// + glows on hover; pass `as` to render a Link / button. Defaults to div.
// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
// InfoTip — a tap/click-to-toggle "ⓘ" popover. Works on touch (a title=
// tooltip is invisible on mobile) and inside a clickable parent (e.g. a
// tile wrapped in a <Link>): the button stops event propagation + default
// so opening it never triggers the parent's navigation. Closes on outside
// pointerdown or Escape.
// ──────────────────────────────────────────────────────────────────────
export function InfoTip({
  children,
  label = "More info",
  color,
  size = 12,
  align = "right",
}: {
  children: ReactNode
  label?: string
  color?: string
  size?: number
  align?: "left" | "center" | "right"
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])
  const c = color ?? paletteVar("text")
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onPointerDown={(e) => {
          // InfoTip often sits above a stretched card link. Claim the
          // pointer before that overlay can turn the tap into navigation.
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="relative z-10 inline-flex items-center justify-center leading-none cursor-help focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
        style={{ color: c, opacity: open ? 1 : 0.65, fontSize: size, outlineColor: c }}
      >
        &#9432;
      </button>
      {open && (
        <span
          role="tooltip"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          className={`absolute top-[calc(100%+6px)] z-50 w-[min(20rem,78vw)] whitespace-normal border p-2.5 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal ${
            align === "left"
              ? "left-0"
              : align === "center"
                ? "left-1/2 -translate-x-1/2"
                : "right-0"
          }`}
          style={{
            background: E_STATIC.bg,
            borderColor: `${c}66`,
            color: paletteVar("text"),
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
          }}
        >
          {children}
        </span>
      )}
    </span>
  )
}

export function CornerBox({
  children,
  className = "",
  color,
  label,
  action,
  interactive = false,
  onClick,
  style,
}: {
  children?: ReactNode
  className?: string
  color?: string
  label?: ReactNode
  action?: ReactNode
  interactive?: boolean
  onClick?: () => void
  style?: CSSProperties
}) {
  const [hover, setHover] = useState(false)
  const c = color ?? paletteVar("text")
  const filter =
    interactive && hover ? `drop-shadow(0 0 8px ${c}55)` : undefined
  // Hybrid border: dotted line edges between brighter corner glyphs.
  // Interactive tiles brighten both layers on hover; static tiles fade
  // the dotted edges so they read as accent, not boundary. Opacity
  // (not hex-alpha concatenation) is used because `c` is a `var(...)`
  // CSS function — concatenating a hex-alpha string onto a var() is
  // not valid CSS and the whole border shorthand falls back to default.
  const edgeOpacity = interactive && hover ? 0.55 : 0.23
  const cornerOpacity = interactive && hover ? 0.95 : 0.8
  const isButton = interactive && !!onClick
  const Tag = isButton ? "button" : "div"
  return (
    <Tag
      onClick={onClick}
      type={isButton ? "button" : undefined}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      onFocus={interactive ? () => setHover(true) : undefined}
      onBlur={interactive ? () => setHover(false) : undefined}
      className={`cz-card relative text-left w-full ${
        interactive
          ? "cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
          : ""
      } ${className}`}
      style={{
        color: c,
        filter,
        transition: "filter 200ms ease-out",
        outlineColor: interactive ? c : undefined,
        // Fallback pad when density CSS vars aren't applied yet (SSR /
        // first paint). 0.75rem = original px-3; TIGHT keeps this floor.
        padding: "var(--cz-card-pad, 0.75rem)",
        paddingLeft: "var(--cz-card-pad-x, var(--cz-card-pad, 0.75rem))",
        paddingRight: "var(--cz-card-pad-x, var(--cz-card-pad, 0.75rem))",
        ...style,
      }}
    >
      {/* Dotted line edges — inset 6px from each corner glyph so the
          two layers feel like one continuous border without the
          glyphs sitting on top of the line. Span carries the opacity;
          border-color is a clean var() reference. */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-[6px] right-[6px]"
        style={{
          borderTop: `1px dotted ${c}`,
          opacity: edgeOpacity,
          transition: "opacity 200ms ease-out",
        }}
      />
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-[6px] right-[6px]"
        style={{
          borderBottom: `1px dotted ${c}`,
          opacity: edgeOpacity,
          transition: "opacity 200ms ease-out",
        }}
      />
      <span
        aria-hidden="true"
        className="absolute left-0 top-[6px] bottom-[6px]"
        style={{
          borderLeft: `1px dotted ${c}`,
          opacity: edgeOpacity,
          transition: "opacity 200ms ease-out",
        }}
      />
      <span
        aria-hidden="true"
        className="absolute right-0 top-[6px] bottom-[6px]"
        style={{
          borderRight: `1px dotted ${c}`,
          opacity: edgeOpacity,
          transition: "opacity 200ms ease-out",
        }}
      />
      {/* Brighter corner glyphs — anchor the identity */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 leading-none select-none"
        style={{
          color: c,
          opacity: cornerOpacity,
          transition: "opacity 200ms ease-out",
        }}
      >
        ┌
      </span>
      <span
        aria-hidden="true"
        className="absolute top-0 right-0 leading-none select-none"
        style={{
          color: c,
          opacity: cornerOpacity,
          transition: "opacity 200ms ease-out",
        }}
      >
        ┐
      </span>
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 leading-none select-none"
        style={{
          color: c,
          opacity: cornerOpacity,
          transition: "opacity 200ms ease-out",
        }}
      >
        └
      </span>
      <span
        aria-hidden="true"
        className="absolute bottom-0 right-0 leading-none select-none"
        style={{
          color: c,
          opacity: cornerOpacity,
          transition: "opacity 200ms ease-out",
        }}
      >
        ┘
      </span>
      {(label || action) && (
        <div className="flex items-baseline mb-2 gap-2 min-w-0">
          {label && (
            <span
              className="text-[11px] tracking-[0.3em] font-bold truncate min-w-0"
              style={{ color: `${paletteVar("text")}` , opacity: 0.75 }}
            >
              {label}
            </span>
          )}
          {action && (
            <span
              className="ml-auto shrink-0 text-[11px] tracking-[0.2em]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              {action}
            </span>
          )}
        </div>
      )}
      {children}
    </Tag>
  )
}

// ──────────────────────────────────────────────────────────────────────
// BlockProgress — █████░░░ phosphor bar that animates in.
// ──────────────────────────────────────────────────────────────────────
export function BlockProgress({
  pct,
  width = 24,
  color,
  label,
  sub,
  animated = true,
}: {
  pct: number
  width?: number
  color?: string
  label?: ReactNode
  sub?: ReactNode
  animated?: boolean
}) {
  const c = color ?? paletteVar("text")
  const target = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const [filled, setFilled] = useState(animated ? 0 : target)
  useEffect(() => {
    if (!animated) {
      setFilled(target)
      return
    }
    let frame: number
    let i = 0
    const step = () => {
      i = Math.min(i + 1, target)
      setFilled(i)
      if (i < target) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, animated])
  return (
    <div className="font-mono text-[11px]">
      {(label || sub) && (
        <div className="flex items-baseline mb-0.5">
          {label && <span style={{ color: c, opacity: 0.7 }}>{label}</span>}
          {sub && (
            <span className="ml-auto tabular-nums" style={{ color: c }}>
              {sub}
            </span>
          )}
        </div>
      )}
      <div
        className="leading-none whitespace-pre"
        style={{ color: c, textShadow: `0 0 4px ${c}44` }}
      >
        {"█".repeat(filled)}
        <span style={{ opacity: 0.2 }}>{"░".repeat(width - filled)}</span>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// PhosphorSpark — animated sparkline with glow + draw-in. Skips the
// draw-in on subsequent renders so live ticks don't reset it.
//
// Wrapped in `memo` at the bottom of this section. Combined with
// callers memoizing their `values` array, a SWR tick on any non-prices
// endpoint skips the path recompute + draw-in effect entirely.
// ──────────────────────────────────────────────────────────────────────
function PhosphorSparkImpl({
  values,
  color,
  width = 200,
  height = 36,
  strokeWidth = 1.4,
  animate = true,
  glow = true,
}: {
  values: number[]
  color?: string
  width?: number
  height?: number
  strokeWidth?: number
  animate?: boolean
  glow?: boolean
}) {
  const pathRef = useRef<SVGPathElement | null>(null)
  const animatedRef = useRef(false)
  const pageVisible = usePageVisible()
  const c = color ?? paletteVar("text")
  const path = useMemo(() => {
    if (!values || values.length < 2) return { d: "", lastX: 0, lastY: 0 }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const stepX = width / (values.length - 1)
    const pts = values.map(
      (v, i) => [i * stepX, height - ((v - min) / span) * height] as const
    )
    const d = pts
      .map(([x, y], i) => (i === 0 ? "M" : "L") + x + "," + y)
      .join(" ")
    return { d, lastX: pts[pts.length - 1][0], lastY: pts[pts.length - 1][1] }
  }, [values, width, height])

  useEffect(() => {
    if (!animate || !pathRef.current) return
    if (animatedRef.current) {
      // Subsequent renders (live tick OR period change) — wipe the
      // stale dasharray from the first draw-in. Without this, when
      // the user switches period (7D → 1M etc.) the new path is
      // longer than the old `getTotalLength()` cached on the
      // element, so the path is clipped and the trailing dot looks
      // stranded past the visible line.
      pathRef.current.style.strokeDasharray = "none"
      pathRef.current.style.strokeDashoffset = "0"
      pathRef.current.style.transition = "none"
      return
    }
    animatedRef.current = true
    const len = pathRef.current.getTotalLength()
    pathRef.current.style.strokeDasharray = String(len)
    pathRef.current.style.strokeDashoffset = String(len)
    pathRef.current.style.transition =
      "stroke-dashoffset 900ms cubic-bezier(0.4, 0, 0.2, 1)"
    requestAnimationFrame(() => {
      if (pathRef.current) pathRef.current.style.strokeDashoffset = "0"
    })
  }, [path.d, animate])

  if (!values || values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}
      />
    )
  }
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        overflow: "visible",
        display: "block",
        filter: glow ? `drop-shadow(0 0 3px ${c}66)` : "none",
      }}
    >
      <path
        ref={pathRef}
        d={path.d}
        fill="none"
        stroke={c}
        strokeWidth={strokeWidth}
        strokeLinecap="square"
        strokeLinejoin="miter"
        shapeRendering="optimizeSpeed"
      />
      {/* Trailing pulse dot. The scale animation lives on the <circle>,
          NOT the positioning <g>: a CSS `transform` (from the keyframes)
          overrides an element's SVG `transform` attribute, so animating
          the same <g> that carries `translate(lastX lastY)` would discard
          the translate and snap the dot to the viewBox origin. The circle
          positions via cx/cy (no transform of its own) and pulses around
          its own center (transform-box: fill-box). */}
      <g transform={`translate(${path.lastX} ${path.lastY})`}>
        <circle
          className={pageVisible ? "cz-spark-pulse" : undefined}
          cx={0}
          cy={0}
          r="2.5"
          fill={c}
          shapeRendering="optimizeSpeed"
        />
      </g>
    </svg>
  )
}
export const PhosphorSpark = memo(PhosphorSparkImpl)

// ──────────────────────────────────────────────────────────────────────
// LiveNumber — shows a value with a green/red tick-flash + ▲/▼ arrow
// micro-animation whenever it changes. Re-uses the existing
// useFlashOnChange hook for parity with the main site.
// ──────────────────────────────────────────────────────────────────────
export function LiveNumber({
  value,
  format,
  color,
  className = "",
}: {
  value: number | null | undefined
  format?: (v: number) => string
  color?: string
  className?: string
}) {
  const flash = useFlashOnChange(value ?? null)
  const c = color ?? paletteVar("text")
  const arrowColor =
    flash === "up" ? paletteVar("cyph") : flash === "down" ? E_STATIC.red : "transparent"
  const bgFlash =
    flash === "up"
      ? "rgba(52, 211, 153, 0.22)"
      : flash === "down"
        ? "rgba(248, 113, 113, 0.22)"
        : "transparent"
  return (
    <span className={`relative inline-block tabular-nums ${className}`}>
      <span
        className="absolute -inset-x-1.5 -inset-y-0.5 rounded transition-colors pointer-events-none"
        style={{
          background: bgFlash,
          boxShadow: flash ? `0 0 12px ${arrowColor}44` : "none",
          transition: "background 0.7s ease-out, box-shadow 0.7s ease-out",
        }}
      />
      <span
        className="relative"
        style={{
          color: c,
          textShadow: flash
            ? `0 0 8px ${arrowColor}99`
            : `0 0 8px ${c}33`,
          transition: "text-shadow 0.7s ease-out",
        }}
      >
        {value == null || !Number.isFinite(value)
          ? "—"
          : format
            ? format(value)
            : String(value)}
      </span>
      {flash && (
        <span
          key={value ?? 0}
          aria-hidden="true"
          className="absolute -right-4 top-1/2 -translate-y-1/2 text-[11px] font-bold pointer-events-none"
          style={{
            color: arrowColor,
            animation: "cz-tick-arrow 900ms ease-out forwards",
          }}
        >
          {flash === "up" ? "▲" : "▼"}
        </span>
      )}
    </span>
  )
}

// Half-of-0.01%: anything closer to zero than this rounds to "0.00%"
// in the display, so we should NOT colour it red just because the
// underlying number happens to be a tiny negative (e.g. -0.0008%).
// Used by PerfGrid + PerfBadge so the "no real movement" state reads
// the same everywhere.
const PERF_FLAT_EPSILON = 0.005

// ──────────────────────────────────────────────────────────────────────
// PerfGrid — 4-cell 24H/7D/30D/90D row. Center-aligned, tinted by
// up/down. Pass `null` for any cell to render an em-dash placeholder.
// Values within ±0.005% are treated as "flat" — neutral colour, no
// leading sign — so a market-closed close-to-close read of effective
// zero doesn't surface a misleading red row.
// ──────────────────────────────────────────────────────────────────────
export function PerfGrid({
  p24,
  p7,
  p30,
  p90,
}: {
  p24: number | null | undefined
  p7: number | null | undefined
  p30: number | null | undefined
  p90: number | null | undefined
}) {
  const cells: [string, number | null | undefined][] = [
    ["24H", p24],
    ["7D", p7],
    ["30D", p30],
    ["90D", p90],
  ]
  return (
    <div className="grid grid-cols-4 font-mono text-[11px]">
      {cells.map(([l, v], i) => {
        const ok = v != null && Number.isFinite(v)
        const flat = ok && Math.abs(v) < PERF_FLAT_EPSILON
        const c = !ok || flat
          ? `${paletteVar("text")}`
          : v >= 0
            ? paletteVar("cyph")
            : E_STATIC.red
        const tint = !ok || flat ? "transparent" : `${c}0a`
        return (
          <div
            key={i}
            className={`px-1.5 py-1.5 text-center transition-colors ${
              i < 3 ? "border-r" : ""
            }`}
            style={{
              borderColor: `${c}44`,
              background: tint,
            }}
          >
            <div
              className="tracking-wider"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              {l}
            </div>
            <div
              className="font-bold tabular-nums"
              style={{ color: c, opacity: !ok ? 0.5 : flat ? 0.75 : 1 }}
            >
              {!ok
                ? "—"
                : flat
                  ? "0.00%"
                  : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// ETabs — terminal-style chip row with a glowing phosphor underline
// on the active item.
// ──────────────────────────────────────────────────────────────────────
export function ETabs<T extends string>({
  items,
  active,
  onChange,
  compact = false,
}: {
  items: readonly (readonly [T, string])[]
  active: T
  onChange: (v: T) => void
  compact?: boolean
}) {
  return (
    <div
      className={`flex items-center font-mono ${compact ? "gap-px text-[11px]" : "gap-px sm:gap-1 text-[11px]"}`}
    >
      {items.map(([v, l]) => {
        const on = active === v
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={on}
            className={`transition-colors relative group whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 ${compact ? "px-1 py-0.5" : "px-1.5 sm:px-2.5 py-1"}`}
            style={{
              color: on ? paletteVar("cyph") : paletteVar("text"),
              opacity: on ? 1 : 0.6,
              outlineColor: paletteVar("cyph"),
            }}
          >
            <span className="whitespace-nowrap">
              {!compact && <span className="hidden sm:inline">[{on ? "■" : " "}</span>}
              {l}
              {!compact && <span className="hidden sm:inline">]</span>}
            </span>
            {on && (
              <span
                aria-hidden="true"
                className={`absolute h-[1px] ${compact ? "left-0 right-0 bottom-0" : "left-1 sm:left-2 right-1 sm:right-2 -bottom-0.5"}`}
                style={{
                  background: paletteVar("cyph"),
                  boxShadow: `0 0 4px ${paletteVar("cyph")}`,
                }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// SingleLineChartE — one labelled phosphor line over time. Used by
// portfolio "VALUE · 90D" where there's exactly one series to plot
// and re-using MultiLineChartE would mislabel its tooltips. The
// tooltip uses the caller-supplied `valueFormat` so portfolio can
// show fmtUSD, while a daily-volume chart could show fmtCompactUSD,
// without the chart itself owning that knowledge.
// ──────────────────────────────────────────────────────────────────────
export interface SingleLinePoint {
  date: string
  value: number
}

export function SingleLineChartE({
  data,
  height = 240,
  color,
  valueFormat = (v) => v.toFixed(2),
  emptyMessage = "Not enough data yet to render the chart.",
}: {
  data: SingleLinePoint[]
  height?: number
  color?: string
  valueFormat?: (v: number) => string
  emptyMessage?: string
}) {
  const w = 900
  const padding = { l: 60, r: 16, t: 4, b: 18 }
  const innerW = w - padding.l - padding.r
  const innerH = height - padding.t - padding.b
  const [hover, setHover] = useState<number | null>(null)
  const c = color ?? paletteVar("ratio")
  const textCol = paletteVar("text")

  const series = useMemo(
    () => data.filter((d) => Number.isFinite(d.value)),
    [data]
  )
  if (series.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: DEFAULT_PALETTE.text, opacity: 0.6 }}
      >
        {emptyMessage}
      </div>
    )
  }

  const values = series.map((d) => d.value)
  const vmin = Math.min(...values)
  const vmax = Math.max(...values)
  const span = vmax - vmin || 1
  const scaleX = (i: number) =>
    padding.l + (i / (series.length - 1)) * innerW
  const scaleY = (v: number) =>
    padding.t + (1 - (v - vmin) / span) * innerH
  const path = values
    .map((v, i) => (i === 0 ? "M" : "L") + scaleX(i) + "," + scaleY(v))
    .join(" ")
  // Area fill below the line for a richer look without an extra prop.
  const area =
    path +
    ` L ${scaleX(series.length - 1)},${padding.t + innerH}` +
    ` L ${scaleX(0)},${padding.t + innerH} Z`

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const idx = Math.round(((x - padding.l) / innerW) * (series.length - 1))
    if (idx >= 0 && idx < series.length) setHover(idx)
  }

  return (
    <svg
      role="img"
      aria-label="Single-series history"
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ overflow: "visible", filter: `drop-shadow(0 0 4px ${c}40)` }}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
        <line
          key={i}
          x1={padding.l}
          y1={padding.t + t * innerH}
          x2={w - padding.r}
          y2={padding.t + t * innerH}
          stroke={textCol}
          strokeOpacity={0.12}
          strokeDasharray="1 4"
        />
      ))}
      <path d={area} fill={c} fillOpacity={0.08} />
      <path d={path} fill="none" stroke={c} strokeWidth={1.6} />
      <text
        x={padding.l - 6}
        y={padding.t + 6}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        {valueFormat(vmax)}
      </text>
      <text
        x={padding.l - 6}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        {valueFormat(vmin)}
      </text>
      {[0, 0.5, 1].map((t, i) => {
        const idx = Math.round(t * (series.length - 1))
        return (
          <text
            key={i}
            x={scaleX(idx)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            fontSize="12"
            fontFamily="ui-monospace, monospace"
            fill={textCol}
            fillOpacity={0.5}
          >
            {series[idx].date}
          </text>
        )
      })}
      {hover != null && series[hover] && (
        <g>
          <line
            x1={scaleX(hover)}
            y1={padding.t}
            x2={scaleX(hover)}
            y2={padding.t + innerH}
            stroke={c}
            strokeOpacity={0.6}
            strokeDasharray="2 2"
          />
          <circle cx={scaleX(hover)} cy={scaleY(series[hover].value)} r={3.5} fill={c} />
          <g
            transform={`translate(${Math.min(scaleX(hover) + 10, w - padding.r - 130)}, ${padding.t + 6})`}
          >
            <rect width="130" height="32" fill="#000" stroke={c} strokeOpacity={0.6} />
            <text
              x={6}
              y={13}
              fontSize="12"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{series[hover].date}]
            </text>
            <text
              x={6}
              y={26}
              fontSize="14"
              fontFamily="ui-monospace, monospace"
              fill={c}
            >
              {valueFormat(series[hover].value)}
            </text>
          </g>
        </g>
      )}
    </svg>
  )
}

// ──────────────────────────────────────────────────────────────────────
// MultiLineChartE — overlay chart for CYPH / ZEC / ratio. Uses the
// pre-aligned `history` shape returned by /api/prices. Crosshair +
// tooltip on hover. Falls back gracefully on a single-point series.
// ──────────────────────────────────────────────────────────────────────
export interface MultiLinePoint {
  date: string
  cyph: number | null
  zec: number
  ratio: number | null
}

// Wrapped in `memo` below — combined with the dashboard memoizing its
// `data` array and other props being primitives, a SWR tick on any
// non-prices endpoint (quote, markets, holdings, etc.) skips the
// chart's re-render entirely. The chart is the single most expensive
// subtree on the dashboard and was previously re-rendering on every
// 30s /api/quote tick despite the historical series being unchanged.
function MultiLineChartEImpl({
  data,
  height = 240,
  showRatio = true,
  viewBoxWidth = 900,
  primaryLabel = "CYPH",
  primaryColor,
  primaryValueFormat = (v) => `$${v.toFixed(2)}`,
  ratioLabel = "R",
  ratioValueFormat = (v) => v.toFixed(4),
  glow = false,
}: {
  data: MultiLinePoint[]
  height?: number
  showRatio?: boolean
  /** SVG drop-shadow filter — pretty but expensive on a live dashboard. */
  glow?: boolean
  /** SVG viewBox width. Default 900 matches the desktop tile aspect.
   *  Mobile callers should pass something closer to the actual
   *  rendered pixel width (e.g. 360) so the chart doesn't stretch
   *  horizontally and squish text via `preserveAspectRatio="none"`. */
  viewBoxWidth?: number
  primaryLabel?: string
  primaryColor?: string
  primaryValueFormat?: (v: number) => string
  ratioLabel?: string
  ratioValueFormat?: (v: number) => string
}) {
  const w = viewBoxWidth
  const padding = { l: 46, r: 46, t: 16, b: 18 }
  const innerW = Math.max(50, w - padding.l - padding.r)
  const innerH = height - padding.t - padding.b
  const [hover, setHover] = useState<number | null>(null)
  // Refs + draw-in hook MUST sit above the early-return below; React's
  // rules-of-hooks reject any hook called after a conditional `return`.
  const cyphPathRef = useRef<SVGPathElement | null>(null)
  const cyphCol = primaryColor ?? paletteVar("cyph")
  const zecCol = paletteVar("zec")
  const ratioCol = paletteVar("ratio")
  const textCol = paletteVar("text")

  // Filter to points with all three series present so the chart's
  // ratio line stays continuous.
  const series = useMemo(() => {
    return data.filter(
      (d) =>
        d.cyph != null &&
        Number.isFinite(d.cyph) &&
        Number.isFinite(d.zec) &&
        (!showRatio || (d.ratio != null && Number.isFinite(d.ratio)))
    )
  }, [data, showRatio])

  // Compute path-D up front so the draw-in hook can react to it on
  // every render (including when the series shrinks back below the
  // 2-point threshold). Empty `series` produces empty path strings.
  const hasSeries = series.length >= 2
  const scaleX = (i: number) =>
    padding.l + (i / Math.max(1, series.length - 1)) * innerW
  const cyphs = series.map((d) => d.cyph as number)
  const zecs = series.map((d) => d.zec)
  const cmin = hasSeries ? Math.min(...cyphs) : 0
  const cmax = hasSeries ? Math.max(...cyphs) : 1
  const zmin = hasSeries ? Math.min(...zecs) : 0
  const zmax = hasSeries ? Math.max(...zecs) : 1
  const rmin =
    hasSeries && showRatio
      ? Math.min(...series.map((d) => d.ratio as number))
      : 0
  const rmax =
    hasSeries && showRatio
      ? Math.max(...series.map((d) => d.ratio as number))
      : 1
  const sc = (v: number) =>
    padding.t + (1 - (v - cmin) / (cmax - cmin || 1)) * innerH
  const sz = (v: number) =>
    padding.t + (1 - (v - zmin) / (zmax - zmin || 1)) * innerH
  const sr = (v: number) =>
    padding.t + (1 - (v - rmin) / (rmax - rmin || 1)) * innerH

  const pathD = (
    pts: number[],
    mapY: (v: number) => number
  ) =>
    pts
      .map((v, i) => (i === 0 ? "M" : "L") + scaleX(i) + "," + mapY(v))
      .join(" ")

  const cyphD = hasSeries ? pathD(cyphs, sc) : ""
  const zecD = hasSeries ? pathD(zecs, sz) : ""
  const ratioD =
    hasSeries && showRatio
      ? pathD(series.map((d) => d.ratio as number), sr)
      : ""

  // Draw-in animation — only on the solid CYPH line. ZEC + ratio
  // have their own stylistic stroke-dasharray (dashed / dotted) so
  // the dasharray-based draw-in would fight with their styling;
  // they appear instantly. Hook respects motion=off + reduced-motion.
  useChartDrawIn(cyphPathRef, cyphD)

  if (!hasSeries) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: DEFAULT_PALETTE.text, opacity: 0.6 }}
      >
        Not enough history yet to render the chart.
      </div>
    )
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const idx = Math.round(((x - padding.l) / innerW) * (series.length - 1))
    if (idx >= 0 && idx < series.length) setHover(idx)
  }

  return (
    <svg
      role="img"
      aria-label={`${primaryLabel}, ZEC, and ratio history`}
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onTouchEnd={() => setHover(null)}
      style={{
        filter: glow ? "drop-shadow(0 0 4px rgba(134,239,172,0.25))" : undefined,
        overflow: "visible",
        display: "block",
      }}
    >
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <line
            key={i}
            x1={padding.l}
            y1={padding.t + t * innerH}
            x2={w - padding.r}
            y2={padding.t + t * innerH}
            stroke={textCol}
            strokeOpacity={0.12}
            strokeDasharray="1 4"
          />
        ))}
      <path
        ref={cyphPathRef}
        d={cyphD}
        fill="none"
        stroke={cyphCol}
        strokeWidth={1.6}
        shapeRendering="optimizeSpeed"
      />
      <path
        d={zecD}
        fill="none"
        stroke={zecCol}
        strokeWidth={1.6}
        strokeDasharray="3 2"
        shapeRendering="optimizeSpeed"
      />
      {showRatio && (
        <path
          d={ratioD}
          fill="none"
          stroke={ratioCol}
          strokeWidth={1.3}
          strokeDasharray="1 2"
          opacity={0.85}
          shapeRendering="optimizeSpeed"
        />
      )}
      {/* Axis titles — make it unambiguous which side belongs to which
          series, since both axes are dollar-denominated but at very
          different scales. */}
      <text
        x={padding.l - 6}
        y={padding.t - 6}
        textAnchor="end"
        fontSize="10"
        fill={cyphCol}
        fillOpacity={0.9}
        fontFamily="ui-monospace, monospace"
        fontWeight="bold"
      >
        [{primaryLabel}]
      </text>
      <text
        x={w - padding.r + 6}
        y={padding.t - 6}
        fontSize="10"
        fill={zecCol}
        fillOpacity={0.9}
        fontFamily="ui-monospace, monospace"
        fontWeight="bold"
      >
        [ZEC]
      </text>

      {/* Y-axis ticks mirror the horizontal grid lines so every major
          grid line has a corresponding value label on both axes. */}
      {(() => {
        const yTicks = w < 500 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]
        return (
          <>
            {/* Left Y-axis: primary series */}
            {yTicks.map((t) => {
              const y = padding.t + t * innerH
              // t=0 is the top of the chart → max value.
              const v = cmax - t * (cmax - cmin)
              const isMajor = t === 0 || t === 1
              return (
                <g key={`lt-${t}`}>
                  <line
                    x1={padding.l - 4}
                    y1={y}
                    x2={padding.l}
                    y2={y}
                    stroke={cyphCol}
                    strokeOpacity={isMajor ? 0.5 : 0.3}
                  />
                  <text
                    x={padding.l - 7}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={isMajor ? "11" : "10"}
                    fill={cyphCol}
                    fillOpacity={isMajor ? 0.85 : 0.55}
                    fontFamily="ui-monospace, monospace"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {primaryValueFormat(v)}
                  </text>
                </g>
              )
            })}

            {/* Right Y-axis: ZEC */}
            {yTicks.map((t) => {
              const y = padding.t + t * innerH
              // t=0 is the top of the chart → max value.
              const v = zmax - t * (zmax - zmin)
              const isMajor = t === 0 || t === 1
              return (
                <g key={`rt-${t}`}>
                  <line
                    x1={w - padding.r}
                    y1={y}
                    x2={w - padding.r + 4}
                    y2={y}
                    stroke={zecCol}
                    strokeOpacity={isMajor ? 0.5 : 0.3}
                  />
                  <text
                    x={w - padding.r + 7}
                    y={y}
                    dominantBaseline="middle"
                    fontSize={isMajor ? "11" : "10"}
                    fill={zecCol}
                    fillOpacity={isMajor ? 0.85 : 0.55}
                    fontFamily="ui-monospace, monospace"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {"$" + v.toFixed(0)}
                  </text>
                </g>
              )
            })}
          </>
        )
      })()}
      {(w < 500 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((t, i, arr) => {
        const idx = Math.round(t * (series.length - 1))
        return (
          <text
            key={i}
            x={scaleX(idx)}
            y={height - 6}
            textAnchor={
              i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle"
            }
            fontSize="12"
            fontFamily="ui-monospace, monospace"
            fill={textCol}
            fillOpacity={0.5}
          >
            {series[idx].date}
          </text>
        )
      })}
      {hover != null && series[hover] && (
        <g>
          <line
            x1={scaleX(hover)}
            y1={padding.t}
            x2={scaleX(hover)}
            y2={padding.t + innerH}
            stroke={cyphCol}
            strokeOpacity={0.6}
            strokeDasharray="2 2"
          />
          <circle cx={scaleX(hover)} cy={sc(series[hover].cyph as number)} r={3.5} fill={cyphCol} />
          <circle cx={scaleX(hover)} cy={sz(series[hover].zec)} r={3.5} fill={zecCol} />
          {showRatio && series[hover].ratio != null && (
            <circle
              cx={scaleX(hover)}
              cy={sr(series[hover].ratio as number)}
              r={3.5}
              fill={ratioCol}
            />
          )}
          <g
            transform={`translate(${Math.min(scaleX(hover) + 10, w - padding.r - 170)}, ${padding.t + 6})`}
          >
            <rect
              width="170"
              height="58"
              fill="#000"
              stroke={cyphCol}
              strokeOpacity={0.6}
            />
            <text
              x={6}
              y={14}
              fontSize="12"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{series[hover].date}]
            </text>
            <text
              x={6}
              y={27}
              fontSize="13"
              fontFamily="ui-monospace, monospace"
              fill={cyphCol}
            >
              {primaryLabel} {primaryValueFormat(series[hover].cyph as number)}
            </text>
            <text
              x={6}
              y={39}
              fontSize="13"
              fontFamily="ui-monospace, monospace"
              fill={zecCol}
            >
              ZEC ${series[hover].zec.toFixed(2)}
            </text>
            {showRatio && series[hover].ratio != null && (
              <text
                x={6}
                y={51}
                fontSize="13"
                fontFamily="ui-monospace, monospace"
                fill={ratioCol}
              >
                {ratioLabel} {ratioValueFormat(series[hover].ratio as number)}
              </text>
            )}
          </g>
        </g>
      )}
    </svg>
  )
}
export const MultiLineChartE = memo(MultiLineChartEImpl)

// ──────────────────────────────────────────────────────────────────────
// SimpleLineChartE — accessor-driven single-series chart with optional
// area fill + hover crosshair. Distinct from SingleLineChartE because
// callers want to plot fields off arbitrary objects (txHistory.total,
// treasury.history.navPerShare, etc.) without first reshaping to
// `{ date, value }[]`.
// ──────────────────────────────────────────────────────────────────────
export function SimpleLineChartE<T extends { date: string }>({
  data,
  accessor,
  color,
  height = 220,
  format = (v) => v.toLocaleString(),
  label = "",
  showArea = true,
  viewBoxWidth = 900,
}: {
  data: T[]
  accessor: (d: T) => number
  color?: string
  height?: number
  format?: (v: number) => string
  label?: string
  showArea?: boolean
  /** SVG viewBox width. Default 900 fits desktop tile widths. Pass a
   *  smaller value on mobile (~360) so `preserveAspectRatio="none"`
   *  doesn't squish text horizontally. */
  viewBoxWidth?: number
}) {
  const w = viewBoxWidth
  const padding = { l: w < 500 ? 40 : 64, r: 16, t: 4, b: 18 }
  const innerW = Math.max(50, w - padding.l - padding.r)
  const innerH = height - padding.t - padding.b
  const [hover, setHover] = useState<number | null>(null)
  // Refs + draw-in hook stay above the early return for rules-of-hooks
  // compliance (no hooks after a conditional return).
  const linePathRef = useRef<SVGPathElement | null>(null)
  const c = color ?? paletteVar("cyph")
  const textCol = paletteVar("text")

  const series = useMemo(
    () => data.filter((d) => Number.isFinite(accessor(d))),
    [data, accessor]
  )
  const hasSeries = series.length >= 2
  const vals = series.map(accessor)
  const min = hasSeries ? Math.min(...vals) : 0
  const max = hasSeries ? Math.max(...vals) : 1
  const span = max - min || 1
  const scaleX = (i: number) =>
    padding.l + (i / Math.max(1, series.length - 1)) * innerW
  const scaleY = (v: number) => padding.t + (1 - (v - min) / span) * innerH
  const linePath = hasSeries
    ? series
        .map(
          (d, i) =>
            (i === 0 ? "M" : "L") + scaleX(i) + "," + scaleY(accessor(d))
        )
        .join(" ")
    : ""
  const areaPath = hasSeries
    ? linePath +
      ` L${scaleX(series.length - 1)},${padding.t + innerH} L${scaleX(0)},${padding.t + innerH} Z`
    : ""

  useChartDrawIn(linePathRef, linePath)

  if (!hasSeries) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: DEFAULT_PALETTE.text, opacity: 0.6 }}
      >
        Not enough data yet to render the chart.
      </div>
    )
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const idx = Math.round(((x - padding.l) / innerW) * (series.length - 1))
    if (idx >= 0 && idx < series.length) setHover(idx)
  }

  // Stable gradient id per colour so multiple instances on the same page
  // don't share a fill mistakenly. Using the colour hex makes the id
  // deterministic across re-renders so SSR + CSR agree.
  const gid = "spk-" + c.replace(/[^a-zA-Z0-9]/g, "")
  return (
    <svg
      role="img"
      aria-label="History"
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ filter: `drop-shadow(0 0 4px ${c}44)`, overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.25" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
        <line
          key={i}
          x1={padding.l}
          y1={padding.t + t * innerH}
          x2={w - padding.r}
          y2={padding.t + t * innerH}
          stroke={textCol}
          strokeOpacity={0.12}
          strokeDasharray="1 4"
        />
      ))}
      {showArea && <path d={areaPath} fill={`url(#${gid})`} />}
      <path ref={linePathRef} d={linePath} fill="none" stroke={c} strokeWidth={1.6} />
      <text
        x={padding.l - 6}
        y={padding.t + 6}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        {format(max)}
      </text>
      <text
        x={padding.l - 6}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        {format(min)}
      </text>
      {(w < 500 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((t, i, arr) => {
        const idx = Math.round(t * (series.length - 1))
        return (
          <text
            key={i}
            x={scaleX(idx)}
            y={height - 6}
            textAnchor={
              i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle"
            }
            fontSize="12"
            fontFamily="ui-monospace, monospace"
            fill={textCol}
            fillOpacity={0.5}
          >
            {series[idx].date}
          </text>
        )
      })}
      {hover != null && series[hover] && (
        <g>
          <line
            x1={scaleX(hover)}
            y1={padding.t}
            x2={scaleX(hover)}
            y2={padding.t + innerH}
            stroke={c}
            strokeOpacity={0.6}
            strokeDasharray="2 2"
          />
          <circle
            cx={scaleX(hover)}
            cy={scaleY(accessor(series[hover]))}
            r={3.5}
            fill={c}
          />
          <g
            transform={`translate(${Math.min(scaleX(hover) + 10, w - padding.r - 150)}, ${padding.t + 6})`}
          >
            <rect width="150" height="36" fill="#000" stroke={c} strokeOpacity={0.6} />
            <text
              x={6}
              y={14}
              fontSize="12"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{series[hover].date}]
            </text>
            <text
              x={6}
              y={28}
              fontSize="14"
              fontFamily="ui-monospace, monospace"
              fill={c}
            >
              {label ? label + " " : ""}
              {format(accessor(series[hover]))}
            </text>
          </g>
        </g>
      )}
    </svg>
  )
}

// ──────────────────────────────────────────────────────────────────────
// StackedAreaChart — phosphor-styled stacked area for the shielded
// pool composition view. Stack order matches the upstream pool order
// (sprout → sapling → orchard → lockbox). Hover crosshair + tooltip
// shows per-pool ZEC counts at the hovered date.
// ──────────────────────────────────────────────────────────────────────
export interface StackedAreaPoint {
  date: string
  [k: string]: string | number
}

export function StackedAreaChart({
  data,
  keys,
  colors,
  height = 260,
  format = (v) => (v / 1e6).toFixed(2) + "M",
  viewBoxWidth = 900,
}: {
  data: StackedAreaPoint[]
  keys: string[]
  colors: string[]
  height?: number
  format?: (v: number) => string
  viewBoxWidth?: number
}) {
  const w = viewBoxWidth
  const padding = { l: w < 500 ? 40 : 64, r: 16, t: 4, b: 18 }
  const innerW = Math.max(50, w - padding.l - padding.r)
  const innerH = height - padding.t - padding.b
  const [hover, setHover] = useState<number | null>(null)
  const textCol = paletteVar("text")

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: DEFAULT_PALETTE.text, opacity: 0.6 }}
      >
        Per-pool history pending — chart will render once the upstream
        endpoint catches up.
      </div>
    )
  }

  // Stacked totals per point — for each `data[i]`, compute the
  // cumulative [bottom, top] band each layer occupies. Using a single
  // pass lets us emit one polygon per layer below.
  const stacks = data.map((d) => {
    let cum = 0
    return keys.map((k) => {
      const v = Number(d[k]) || 0
      const band: [number, number] = [cum, cum + v]
      cum += v
      return band
    })
  })
  const max = Math.max(...stacks.map((s) => s[s.length - 1][1])) || 1
  const scaleX = (i: number) =>
    padding.l + (i / (data.length - 1)) * innerW
  const scaleY = (v: number) => padding.t + (1 - v / max) * innerH

  const polys = keys.map((_, layerIdx) => {
    const topPts = stacks.map((s, i) => scaleX(i) + "," + scaleY(s[layerIdx][1]))
    const botPts = stacks
      .map((s, i) => scaleX(i) + "," + scaleY(s[layerIdx][0]))
      .reverse()
    return [...topPts, ...botPts].join(" ")
  })

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const idx = Math.round(((x - padding.l) / innerW) * (data.length - 1))
    if (idx >= 0 && idx < data.length) setHover(idx)
  }

  return (
    <svg
      role="img"
      aria-label="Shielded pool composition"
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ overflow: "visible" }}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
        <line
          key={i}
          x1={padding.l}
          y1={padding.t + t * innerH}
          x2={w - padding.r}
          y2={padding.t + t * innerH}
          stroke={textCol}
          strokeOpacity={0.12}
          strokeDasharray="1 4"
        />
      ))}
      {polys.map((p, i) => (
        <polygon
          key={i}
          points={p}
          fill={colors[i]}
          fillOpacity={0.55}
          stroke={colors[i]}
          strokeWidth={1}
        />
      ))}
      <text
        x={padding.l - 6}
        y={padding.t + 6}
        textAnchor="end"
        fontSize="12"
        fill={textCol}
        fillOpacity={0.7}
        fontFamily="ui-monospace, monospace"
      >
        {format(max)}
      </text>
      <text
        x={padding.l - 6}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="12"
        fill={textCol}
        fillOpacity={0.7}
        fontFamily="ui-monospace, monospace"
      >
        0
      </text>
      {[0, 0.5, 1].map((t, i) => {
        const idx = Math.round(t * (data.length - 1))
        return (
          <text
            key={i}
            x={scaleX(idx)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            fontSize="12"
            fontFamily="ui-monospace, monospace"
            fill={textCol}
            fillOpacity={0.5}
          >
            {data[idx].date}
          </text>
        )
      })}
      {hover != null && data[hover] && (
        <g>
          <line
            x1={scaleX(hover)}
            y1={padding.t}
            x2={scaleX(hover)}
            y2={padding.t + innerH}
            stroke={textCol}
            strokeOpacity={0.6}
            strokeDasharray="2 2"
          />
          <g
            transform={`translate(${Math.min(scaleX(hover) + 10, w - padding.r - 180)}, ${padding.t + 6})`}
          >
            <rect
              width="180"
              height={16 + keys.length * 13}
              fill="#000"
              stroke={paletteVar("ratio")}
              strokeOpacity={0.6}
            />
            <text
              x={6}
              y={13}
              fontSize="12"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{data[hover].date}]
            </text>
            {keys.map((k, i) => (
              <text
                key={k}
                x={6}
                y={26 + i * 13}
                fontSize="13"
                fontFamily="ui-monospace, monospace"
                fill={colors[i]}
              >
                {k.toUpperCase()} {format(Number(data[hover][k]) || 0)}
              </text>
            ))}
          </g>
        </g>
      )}
    </svg>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Ticker — horizontally-scrolling tape of chips. Tripled content for
// seamless loop via CSS keyframe `cz-ticker`. Speed maps 1..5 to
// duration 120s..30s. `chips` is the prepared, filtered list with
// already-formatted values; the parent owns SWR + chip selection so
// the ticker stays a presentational primitive.
// ──────────────────────────────────────────────────────────────────────
export interface TickerChip {
  key: string
  symbol: string
  value: string
  change?: number | null
  sub?: string
  /** Optional colour override for the symbol — used by the headline
   *  trio (CYPH / ZEC / RATIO) so they keep their dashboard tint when
   *  re-enabled in the ticker. */
  color?: string
  /** Optional destination — when set the symbol becomes a link (with a
   *  link glyph) to this route, e.g. the BTC chip → /bitcoin. */
  href?: string
}

const TickerChipRow = memo(function TickerChipRow({
  chip,
  textColor,
}: {
  chip: TickerChip
  textColor: string
}) {
  const symbolColor = chip.color ?? textColor
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums shrink-0">
      {chip.href ? (
        <Link
          href={chip.href}
          className="inline-flex items-center gap-0.5 font-bold tracking-[0.1em] hover:underline underline-offset-2"
          style={{ color: symbolColor }}
          title={`Open ${chip.symbol} vs ZEC stats`}
        >
          {chip.symbol}
          <Link2 aria-hidden="true" size={9} strokeWidth={2.25} />
        </Link>
      ) : (
        <span className="font-bold tracking-[0.1em]" style={{ color: symbolColor }}>
          {chip.symbol}
        </span>
      )}
      <span style={{ color: textColor }}>{chip.value}</span>
      {chip.sub && (
        <span
          className="text-[10px]"
          style={{ color: textColor, opacity: 0.4 }}
        >
          {chip.sub}
        </span>
      )}
      {chip.change != null && Number.isFinite(chip.change) && (
        <span
          style={{
            color: chip.change >= 0 ? paletteVar("cyph") : E_STATIC.red,
          }}
        >
          {chip.change >= 0 ? "▲" : "▼"} {Math.abs(chip.change).toFixed(2)}%
        </span>
      )}
      <span aria-hidden="true" style={{ color: textColor, opacity: 0.3 }}>
        │
      </span>
    </span>
  )
})

function tickerChipsEqual(a: TickerChip[], b: TickerChip[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.key !== y.key ||
      x.symbol !== y.symbol ||
      x.value !== y.value ||
      x.change !== y.change ||
      x.sub !== y.sub ||
      x.color !== y.color ||
      x.href !== y.href
    ) {
      return false
    }
  }
  return true
}

function TickerImpl({
  chips,
  speed = 3,
  className = "",
}: {
  chips: TickerChip[]
  speed?: number
  className?: string
}) {
  const pageVisible = usePageVisible()
  const [hovered, setHovered] = useState(false)
  const looped = useMemo(
    () => (chips?.length ? [...chips, ...chips] : []),
    [chips]
  )
  if (!chips || chips.length === 0) return null
  const clamped = Math.max(1, Math.min(5, speed))
  const duration = 30 + (5 - clamped) * 22.5 // 30s..120s
  const tColor = paletteVar("text")
  return (
    <div
      className={`cz-ticker relative overflow-hidden border-y ${className}`}
      style={{
        borderColor: `${tColor}44`,
        background: "#000",
        height: 32,
      }}
    >
      {/* Longhand animation properties (not shorthand) because React's
          shorthand serialization can reorder values such that the
          `none` keyword for fill-mode ends up being parsed as the
          animation-name (which silently disables the animation). */}
      <div
        className="cz-ticker-track absolute inset-y-0 flex items-center gap-7 whitespace-nowrap"
        style={{
          "--cz-ticker-duration": `${duration}s`,
          animationName: "cz-ticker",
          animationDuration: `${duration}s`,
          animationTimingFunction: "linear",
          animationIterationCount: "infinite",
          animationPlayState: pageVisible ? "running" : "paused",
        } as CSSProperties & Record<"--cz-ticker-duration", string>}
      >
        {looped.map((chip, i) => (
          <TickerChipRow key={chip.key + "-" + i} chip={chip} textColor={tColor} />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-8 pointer-events-none"
        style={{ background: "linear-gradient(to right, #000, transparent)" }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 w-8 pointer-events-none"
        style={{ background: "linear-gradient(to left, #000, transparent)" }}
      />
    </div>
  )
}

export const Ticker = memo(
  TickerImpl,
  (prev, next) =>
    prev.speed === next.speed &&
    prev.className === next.className &&
    tickerChipsEqual(prev.chips, next.chips)
)
