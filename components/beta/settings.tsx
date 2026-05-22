"use client"

import useSWR from "swr"
import {
  CornerBox,
  LED,
  PhosphorSpark,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { swrFetcher } from "./format"
import { E_PALETTES, type PaletteName } from "./palettes"
import {
  useCyphzecSettings,
  type CyphzecSettings,
} from "./use-cyphzec-settings"
import type { PricesResponse } from "./api-types"

function SegRow<T extends string>({
  label,
  value,
  options,
  onChange,
  color,
}: {
  label: string
  value: T
  options: { value: T; label: string; sub?: string }[]
  onChange: (v: T) => void
  color?: string
}) {
  const c = color ?? paletteVar("cyph")
  return (
    <div
      className="grid grid-cols-[110px_1fr] items-center gap-3 py-3"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span
        className="text-[11px] tracking-[0.15em]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {label}
      </span>
      <div
        className="grid gap-px overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
          border: `1px solid ${paletteVar("text")}33`,
        }}
      >
        {options.map((o, i) => {
          const on = value === o.value
          return (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => onChange(o.value)}
              className="px-2 py-1.5 text-[11px] transition-colors text-center"
              style={{
                background: on ? c + "1f" : "transparent",
                color: on ? c : paletteVar("text"),
                opacity: on ? 1 : 0.7,
                borderRight:
                  i < options.length - 1
                    ? `1px solid ${paletteVar("text")}22`
                    : "",
                textShadow: on ? `0 0 6px ${c}55` : "none",
              }}
            >
              <div className="font-bold leading-tight">{o.label}</div>
              {o.sub && (
                <div className="text-[9px] opacity-60 mt-0.5">{o.sub}</div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div
      className="grid grid-cols-[110px_1fr] items-center gap-3 py-3"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span
        className="text-[11px] tracking-[0.15em]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="relative inline-flex h-5 w-10 transition-colors"
        style={{
          background: value
            ? `${paletteVar("cyph")}22`
            : `${paletteVar("text")}11`,
          border: `1px solid ${value ? paletteVar("cyph") : `${paletteVar("text")}33`}`,
          boxShadow: value ? `0 0 8px ${paletteVar("cyph")}44` : "none",
        }}
      >
        <span
          aria-hidden="true"
          className="absolute top-0.5 size-3.5 transition-all"
          style={{
            left: value ? "calc(100% - 18px)" : "2px",
            background: value ? paletteVar("cyph") : paletteVar("text"),
            opacity: value ? 1 : 0.6,
            boxShadow: value ? `0 0 6px ${paletteVar("cyph")}` : "none",
          }}
        />
      </button>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "%",
  onChange,
  color,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
  color?: string
}) {
  const c = color ?? paletteVar("cyph")
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div
      className="grid grid-cols-[110px_1fr_44px] items-center gap-3 py-3"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span
        className="text-[11px] tracking-[0.15em]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {label}
      </span>
      <div className="relative h-5 flex items-center">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 h-px"
          style={{ background: `${paletteVar("text")}33` }}
        />
        <div
          aria-hidden="true"
          className="absolute left-0 h-1.5 transition-all"
          style={{
            width: pct + "%",
            background: c,
            boxShadow: `0 0 6px ${c}88`,
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          aria-label={label}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
        />
        <div
          aria-hidden="true"
          className="absolute size-3 pointer-events-none transition-all"
          style={{
            left: `calc(${pct}% - 6px)`,
            background: c,
            boxShadow: `0 0 10px ${c}, 0 0 2px ${c}`,
          }}
        />
      </div>
      <span
        className="text-[11px] tabular-nums text-right font-bold"
        style={{ color: c }}
      >
        {value}
        {unit}
      </span>
    </div>
  )
}

function PaletteSwatches({
  value,
  onChange,
}: {
  value: PaletteName
  onChange: (v: PaletteName) => void
}) {
  return (
    <div
      className="grid grid-cols-[110px_1fr] items-center gap-3 py-3"
      style={{ borderBottom: `1px dotted ${paletteVar("text")}22` }}
    >
      <span
        className="text-[11px] tracking-[0.15em]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        PALETTE
      </span>
      <div className="grid grid-cols-4 gap-1.5">
        {(Object.entries(E_PALETTES) as [PaletteName, (typeof E_PALETTES)[PaletteName]][]).map(
          ([k, p]) => {
            const on = value === k
            return (
              <button
                key={k}
                type="button"
                onClick={() => onChange(k)}
                className="relative flex flex-col items-stretch gap-1.5 px-1.5 py-1.5 transition-all"
                style={{
                  background: on ? p.cyph + "16" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${on ? p.cyph : `${paletteVar("text")}33`}`,
                  boxShadow: on ? `0 0 10px ${p.cyph}55` : "none",
                }}
              >
                <div className="flex gap-px h-4 overflow-hidden">
                  <div
                    className="flex-1"
                    style={{ background: p.cyph, boxShadow: `inset 0 0 4px ${p.cyph}55` }}
                  />
                  <div
                    className="flex-1"
                    style={{ background: p.ratio, boxShadow: `inset 0 0 4px ${p.ratio}55` }}
                  />
                  <div
                    className="flex-1"
                    style={{ background: p.text, boxShadow: `inset 0 0 4px ${p.text}55` }}
                  />
                </div>
                <div
                  className="text-[9px] tracking-[0.08em] uppercase font-bold text-center leading-none whitespace-nowrap overflow-hidden"
                  style={{
                    color: on ? p.cyph : paletteVar("text"),
                    opacity: on ? 1 : 0.65,
                    textShadow: on ? `0 0 6px ${p.cyph}55` : "none",
                  }}
                >
                  {k}
                </div>
              </button>
            )
          }
        )}
      </div>
    </div>
  )
}

export function BetaSettings() {
  const [s, setSetting, reset] = useCyphzecSettings()
  // Tiny live preview — uses the same /api/prices?days=7 series the
  // dashboard subscribes to so SWR dedupes a single fetch.
  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=7",
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const history = prices?.history ?? []
  const cyphSpark = history.map((h) => h.cyph)
  const zecSpark = history.map((h) => h.zec)
  const ratioSpark = history.flatMap((h) => (h.ratio != null ? [h.ratio] : []))
  const cyphPrice = history.length > 0 ? history[history.length - 1].cyph : null
  const zecPrice = history.length > 0 ? history[history.length - 1].zec : null
  const ratio =
    cyphPrice != null && zecPrice != null && zecPrice > 0
      ? cyphPrice / zecPrice
      : null

  const previews: {
    label: string
    color: string
    value: number | null
    format: (v: number) => string
    spark: number[]
  }[] = [
    {
      label: "CYPH",
      color: paletteVar("cyph"),
      value: cyphPrice,
      format: (v) => "$" + v.toFixed(2),
      spark: cyphSpark,
    },
    {
      label: "ZEC",
      color: paletteVar("zec"),
      value: zecPrice,
      format: (v) => "$" + v.toFixed(2),
      spark: zecSpark,
    },
    {
      label: "RATIO",
      color: paletteVar("ratio"),
      value: ratio,
      format: (v) => v.toPrecision(4),
      spark: ratioSpark,
    },
  ]

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">SETTINGS</h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          preferences saved on-device
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5"
          style={{
            color: paletteVar("cyph"),
            border: `1px solid ${paletteVar("cyph")}55`,
          }}
        >
          <LED color={paletteVar("cyph")} size={4} /> AUTOSAVED
        </span>
      </div>

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <CornerBox label="APPEARANCE" color={paletteVar("cyph")}>
          <PaletteSwatches
            value={s.palette}
            onChange={(v) => setSetting("palette", v)}
          />
          <SegRow<CyphzecSettings["density"]>
            label="DENSITY"
            value={s.density}
            onChange={(v) => setSetting("density", v)}
            options={[
              { value: "compact", label: "TIGHT", sub: "denser" },
              { value: "comfortable", label: "NORMAL", sub: "default" },
              { value: "spacious", label: "LOOSE", sub: "roomy" },
            ]}
          />
        </CornerBox>

        <CornerBox label="TERMINAL CHROME" color={paletteVar("ratio")}>
          <SegRow<CyphzecSettings["background"]>
            label="BACKGROUND"
            value={s.background}
            onChange={(v) => setSetting("background", v)}
            color={paletteVar("ratio")}
            options={[
              { value: "scanlines", label: "SCAN", sub: "lines" },
              { value: "grid", label: "GRID", sub: "dots" },
              { value: "both", label: "BOTH", sub: "mixed" },
              { value: "none", label: "OFF", sub: "clean" },
            ]}
          />
          <ToggleRow
            label="CRT VIGNETTE"
            value={s.vignette}
            onChange={(v) => setSetting("vignette", v)}
          />
          <SliderRow
            label="GLOW"
            value={s.glow}
            min={0}
            max={100}
            step={5}
            color={paletteVar("ratio")}
            onChange={(v) => setSetting("glow", v)}
          />
          <SegRow<CyphzecSettings["motion"]>
            label="MOTION"
            value={s.motion}
            onChange={(v) => setSetting("motion", v)}
            color={paletteVar("ratio")}
            options={[
              { value: "full", label: "FULL", sub: "all FX" },
              { value: "subtle", label: "SUBTLE", sub: "minimal" },
              { value: "off", label: "OFF", sub: "static" },
            ]}
          />
        </CornerBox>

        <CornerBox
          label="LIVE PREVIEW"
          color={paletteVar("zec")}
          style={{ gridColumn: "1 / -1" }}
        >
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            }}
          >
            {previews.map((c) => (
              <div
                key={c.label}
                className="p-3"
                style={{ border: `1px solid ${c.color}33` }}
              >
                <div className="flex items-baseline justify-between mb-1">
                  <span
                    className="text-[10px] tracking-[0.3em] font-bold"
                    style={{
                      color: c.color,
                      textShadow: `0 0 6px ${c.color}55`,
                    }}
                  >
                    {c.label}
                  </span>
                  <span
                    className="text-[9px]"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    LIVE
                  </span>
                </div>
                <div
                  className="text-2xl font-bold tabular-nums leading-none"
                  style={{
                    color: c.color,
                    textShadow: `0 0 8px ${c.color}88`,
                  }}
                >
                  {c.value != null && Number.isFinite(c.value)
                    ? c.format(c.value)
                    : "—"}
                </div>
                {c.spark.length >= 2 && (
                  <div className="mt-2">
                    <PhosphorSpark
                      values={c.spark}
                      color={c.color}
                      width={260}
                      height={28}
                      animate={false}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CornerBox>
      </div>

      <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.5 }}
        >
          changes save automatically · stored on-device only · never sent to
          server
        </span>
        <button
          type="button"
          onClick={reset}
          className="px-3 py-1.5 text-[11px] tracking-[0.2em] transition-colors hover:bg-red-950/30"
          style={{ color: E_STATIC.red, border: `1px solid ${E_STATIC.red}66` }}
        >
          RESET TO DEFAULTS
        </button>
      </div>
    </>
  )
}
