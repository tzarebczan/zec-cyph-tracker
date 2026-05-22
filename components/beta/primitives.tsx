"use client"

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useFlashOnChange } from "@/lib/use-flash-on-change"
import { paletteVar, E_STATIC, DEFAULT_PALETTE } from "./theme"

// ──────────────────────────────────────────────────────────────────────
// CRT overlay (scanlines + grid + vignette). Visibility is driven from
// html[data-cz-bg] / data-cz-vignette via beta.css so user settings
// flip them without unmounting the component.
// ──────────────────────────────────────────────────────────────────────
export function CRT() {
  return (
    <>
      <div
        aria-hidden="true"
        className="cz-scanlines absolute inset-0 pointer-events-none z-[1]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(134,239,172,0.04) 0px, rgba(134,239,172,0.04) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <div
        aria-hidden="true"
        className="cz-grid absolute inset-0 pointer-events-none z-[1]"
        style={{
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
      className="inline-block rounded-full align-middle"
      style={{
        width: size,
        height: size,
        background: c,
        boxShadow: `0 0 8px ${c}, 0 0 2px ${c}`,
        animation: "cz-led 1.4s ease-in-out infinite",
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
    interactive && hover ? `drop-shadow(0 0 6px ${c}66)` : undefined
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
      className={`relative px-3 py-3 text-left w-full ${
        interactive ? "cursor-pointer transition-all" : ""
      } ${className}`}
      style={{ color: c, filter, ...style }}
    >
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 leading-none select-none"
        style={{ color: c }}
      >
        ┌
      </span>
      <span
        aria-hidden="true"
        className="absolute top-0 right-0 leading-none select-none"
        style={{ color: c }}
      >
        ┐
      </span>
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 leading-none select-none"
        style={{ color: c }}
      >
        └
      </span>
      <span
        aria-hidden="true"
        className="absolute bottom-0 right-0 leading-none select-none"
        style={{ color: c }}
      >
        ┘
      </span>
      {(label || action) && (
        <div className="flex items-baseline mb-2 gap-2">
          {label && (
            <span
              className="text-[10px] tracking-[0.3em] font-bold"
              style={{ color: `${paletteVar("text")}` , opacity: 0.75 }}
            >
              {label}
            </span>
          )}
          {action && (
            <span
              className="ml-auto text-[10px] tracking-[0.2em]"
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
// ──────────────────────────────────────────────────────────────────────
export function PhosphorSpark({
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
    if (animatedRef.current) return
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
      />
      <circle cx={path.lastX} cy={path.lastY} r="2.5" fill={c}>
        <animate
          attributeName="r"
          values="2.5;3.5;2.5"
          dur="2s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  )
}

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
          className="absolute -right-4 top-1/2 -translate-y-1/2 text-[10px] font-bold pointer-events-none"
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

// ──────────────────────────────────────────────────────────────────────
// PerfGrid — 4-cell 24H/7D/30D/90D row. Center-aligned, tinted by
// up/down. Pass `null` for any cell to render an em-dash placeholder.
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
    <div className="grid grid-cols-4 font-mono text-[10px]">
      {cells.map(([l, v], i) => {
        const c =
          v == null || !Number.isFinite(v)
            ? `${paletteVar("text")}`
            : v >= 0
              ? paletteVar("cyph")
              : E_STATIC.red
        const tint = v == null || !Number.isFinite(v) ? "transparent" : `${c}0a`
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
            <div className="font-bold tabular-nums" style={{ color: c }}>
              {v == null || !Number.isFinite(v)
                ? "—"
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
}: {
  items: readonly (readonly [T, string])[]
  active: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 font-mono text-[11px]">
      {items.map(([v, l]) => {
        const on = active === v
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className="px-2.5 py-1 transition-colors relative group whitespace-nowrap"
            style={{ color: on ? paletteVar("cyph") : paletteVar("text"), opacity: on ? 1 : 0.6 }}
          >
            <span className="whitespace-nowrap">
              [{on ? "■" : "\u00a0"}
              {l}]
            </span>
            {on && (
              <span
                className="absolute left-2 right-2 -bottom-0.5 h-[1px]"
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
  const padding = { l: 60, r: 16, t: 8, b: 22 }
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
        fontSize="9"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        {valueFormat(vmax)}
      </text>
      <text
        x={padding.l - 6}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="9"
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
            fontSize="9"
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
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{series[hover].date}]
            </text>
            <text
              x={6}
              y={26}
              fontSize="11"
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
  cyph: number
  zec: number
  ratio: number | null
}

export function MultiLineChartE({
  data,
  height = 240,
  showRatio = true,
}: {
  data: MultiLinePoint[]
  height?: number
  showRatio?: boolean
}) {
  const w = 900
  const padding = { l: 48, r: 48, t: 8, b: 22 }
  const innerW = w - padding.l - padding.r
  const innerH = height - padding.t - padding.b
  const [hover, setHover] = useState<number | null>(null)
  const cyphCol = paletteVar("cyph")
  const zecCol = paletteVar("zec")
  const ratioCol = paletteVar("ratio")
  const textCol = paletteVar("text")

  // Filter to points with all three series present so the chart's
  // ratio line stays continuous.
  const series = useMemo(() => {
    return data.filter(
      (d) =>
        Number.isFinite(d.cyph) &&
        Number.isFinite(d.zec) &&
        (!showRatio || (d.ratio != null && Number.isFinite(d.ratio)))
    )
  }, [data, showRatio])

  if (series.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: DEFAULT_PALETTE.text, opacity: 0.6 }}
      >
        Not enough history yet to render the chart.
      </div>
    )
  }

  const scaleX = (i: number) =>
    padding.l + (i / (series.length - 1)) * innerW
  const cyphs = series.map((d) => d.cyph)
  const zecs = series.map((d) => d.zec)
  const cmin = Math.min(...cyphs)
  const cmax = Math.max(...cyphs)
  const zmin = Math.min(...zecs)
  const zmax = Math.max(...zecs)
  const rmin = showRatio
    ? Math.min(...series.map((d) => d.ratio as number))
    : 0
  const rmax = showRatio
    ? Math.max(...series.map((d) => d.ratio as number))
    : 1
  const sc = (v: number) =>
    padding.t + (1 - (v - cmin) / (cmax - cmin || 1)) * innerH
  const sz = (v: number) =>
    padding.t + (1 - (v - zmin) / (zmax - zmin || 1)) * innerH
  const sr = (v: number) =>
    padding.t + (1 - (v - rmin) / (rmax - rmin || 1)) * innerH

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const idx = Math.round(((x - padding.l) / innerW) * (series.length - 1))
    if (idx >= 0 && idx < series.length) setHover(idx)
  }

  const pathD = (
    pts: number[],
    mapY: (v: number) => number
  ) =>
    pts
      .map((v, i) => (i === 0 ? "M" : "L") + scaleX(i) + "," + mapY(v))
      .join(" ")

  return (
    <svg
      role="img"
      aria-label="CYPH, ZEC, and ratio history"
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{
        filter: "drop-shadow(0 0 4px rgba(134,239,172,0.25))",
        overflow: "visible",
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
        d={pathD(cyphs, sc)}
        fill="none"
        stroke={cyphCol}
        strokeWidth={1.6}
      />
      <path
        d={pathD(zecs, sz)}
        fill="none"
        stroke={zecCol}
        strokeWidth={1.6}
        strokeDasharray="3 2"
      />
      {showRatio && (
        <path
          d={pathD(
            series.map((d) => d.ratio as number),
            sr
          )}
          fill="none"
          stroke={ratioCol}
          strokeWidth={1.3}
          strokeDasharray="1 2"
          opacity={0.85}
        />
      )}
      <text
        x={padding.l - 6}
        y={padding.t + 6}
        textAnchor="end"
        fontSize="9"
        fill={cyphCol}
        fontFamily="ui-monospace, monospace"
      >
        ${cmax.toFixed(2)}
      </text>
      <text
        x={padding.l - 6}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="9"
        fill={cyphCol}
        fontFamily="ui-monospace, monospace"
      >
        ${cmin.toFixed(2)}
      </text>
      <text
        x={w - padding.r + 6}
        y={padding.t + 6}
        fontSize="9"
        fill={zecCol}
        fontFamily="ui-monospace, monospace"
      >
        ${zmax.toFixed(0)}
      </text>
      <text
        x={w - padding.r + 6}
        y={padding.t + innerH}
        fontSize="9"
        fill={zecCol}
        fontFamily="ui-monospace, monospace"
      >
        ${zmin.toFixed(0)}
      </text>
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const idx = Math.round(t * (series.length - 1))
        return (
          <text
            key={i}
            x={scaleX(idx)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
            fontSize="9"
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
          <circle cx={scaleX(hover)} cy={sc(series[hover].cyph)} r={3.5} fill={cyphCol} />
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
            transform={`translate(${Math.min(scaleX(hover) + 10, w - padding.r - 140)}, ${padding.t + 6})`}
          >
            <rect
              width="140"
              height="58"
              fill="#000"
              stroke={cyphCol}
              strokeOpacity={0.6}
            />
            <text
              x={6}
              y={14}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.7}
            >
              [{series[hover].date}]
            </text>
            <text
              x={6}
              y={27}
              fontSize="10"
              fontFamily="ui-monospace, monospace"
              fill={cyphCol}
            >
              CYPH ${series[hover].cyph.toFixed(2)}
            </text>
            <text
              x={6}
              y={39}
              fontSize="10"
              fontFamily="ui-monospace, monospace"
              fill={zecCol}
            >
              ZEC ${series[hover].zec.toFixed(2)}
            </text>
            {showRatio && series[hover].ratio != null && (
              <text
                x={6}
                y={51}
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                fill={ratioCol}
              >
                R {(series[hover].ratio as number).toFixed(4)}
              </text>
            )}
          </g>
        </g>
      )}
    </svg>
  )
}
