"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
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
  BUTTON_BAR_FIXED_KEYS,
  BUTTON_BAR_MAX_ITEMS,
  BUTTON_BAR_OPTION_KEYS,
  DASHBOARD_TILE_DEFAULT_KEYS,
  DASHBOARD_TILE_KEYS,
  HEADER_BAR_MAX_OPTIONS,
  HEADER_BAR_OPTION_KEYS,
  TICKER_CHIP_KEYS,
  sanitizeButtonBar,
  sanitizeDashboardTiles,
  sanitizeHeaderBar,
  type ButtonBarKey,
  type ButtonBarOptionKey,
  type CyphzecSettings,
  type DashboardTileKey,
  type HeaderBarKey,
  type HeaderBarOptionKey,
  type TickerChipKey,
} from "./use-cyphzec-settings"
import { hasPortfolioData, usePortfolioState } from "./portfolio-state"
import type { PricesResponse } from "./api-types"

// Display labels for the ticker chip toggle row — the array order
// matches `TICKER_CHIP_KEYS` so the row reads alphabetically by
// category (cryptos → indices → equities → macro), matching the
// new design's chip strip.
const CHIP_LABELS: Record<TickerChipKey, string> = {
  btc: "BTC",
  eth: "ETH",
  sol: "SOL",
  xrp: "XRP",
  ada: "ADA",
  avax: "AVAX",
  doge: "DOGE",
  hype: "HYPE",
  near: "NEAR",
  spx: "S&P",
  ndx: "NDX",
  dji: "DJI",
  mstr: "MSTR",
  coin: "COIN",
  dxy: "DXY",
  gold: "GOLD",
  vix: "VIX",
}

const BUTTON_BAR_LABELS: Record<ButtonBarKey, string> = {
  home: "HOME",
  rank: "STATS",
  shielding: "SHIELDING",
  exchanges: "EXCHANGES",
  port: "PORTFOLIO",
  est: "ESTIMATOR",
  trsy: "TREASURY",
  whatif: "WHAT IF",
  updates: "UPDATES",
  about: "ABOUT",
  more: "MORE",
  settings: "SETTINGS",
}

const HEADER_BAR_LABELS: Record<HeaderBarKey, string> = {
  home: "DASHBOARD",
  rank: "ZEC STATS",
  shielding: "SHIELDING",
  port: "PORTFOLIO",
  est: "ESTIMATOR",
  trsy: "TREASURY",
  updates: "UPDATES",
  about: "ABOUT",
  settings: "SETTINGS",
}

const DASHBOARD_TILE_LABELS: Record<DashboardTileKey, string> = {
  cyph: "CYPH",
  zec: "ZEC",
  ratio: "RATIO",
  portfolio: "PORTFOLIO",
}

// Pulse "SAVED ✓" for 1.2s after every settings change. Skips the
// initial mount so users don't see the chip flash on first render.
function useSavedPulse(s: CyphzecSettings) {
  const [shown, setShown] = useState(false)
  const initialMount = useRef(true)
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false
      return
    }
    setShown(true)
    const t = setTimeout(() => setShown(false), 1200)
    return () => clearTimeout(t)
    // We watch the entire settings object — any property change should
    // pulse. JSON.stringify keeps the dep stable across renders that
    // produce the same object content (palette swatches re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(s)])
  return shown
}

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
                <div className="text-[10px] opacity-60 mt-0.5">{o.sub}</div>
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
  disabled = false,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
  color?: string
  disabled?: boolean
  hint?: string
}) {
  const c = color ?? paletteVar("cyph")
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div
      className="grid grid-cols-[110px_1fr_44px] items-center gap-3 py-3"
      style={{
        borderBottom: `1px dotted ${paletteVar("text")}22`,
        opacity: disabled ? 0.45 : 1,
      }}
      aria-disabled={disabled || undefined}
    >
      <span
        className="text-[11px] tracking-[0.15em] flex flex-col"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] mt-0.5" style={{ opacity: 0.65 }}>
            {hint}
          </span>
        )}
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
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          aria-label={label}
          className="absolute inset-0 w-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
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
                  className="text-[10px] tracking-[0.08em] uppercase font-bold text-center leading-none whitespace-nowrap overflow-hidden"
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

function ButtonBarManager({
  value,
  onChange,
}: {
  value: ButtonBarKey[]
  onChange: (v: ButtonBarKey[]) => void
}) {
  const current = sanitizeButtonBar(value)
  const optionLimit = BUTTON_BAR_MAX_ITEMS - BUTTON_BAR_FIXED_KEYS.length
  const selectedOptions = current.filter((k): k is ButtonBarOptionKey =>
    BUTTON_BAR_OPTION_KEYS.includes(k as ButtonBarOptionKey)
  )
  const selectedCount = selectedOptions.length
  const color = paletteVar("cyph")

  const setOptions = (options: ButtonBarOptionKey[]) => {
    onChange(sanitizeButtonBar(["home", ...options, "more"]))
  }

  const toggleOption = (key: ButtonBarOptionKey) => {
    const on = selectedOptions.includes(key)
    if (on) {
      setOptions(selectedOptions.filter((k) => k !== key))
      return
    }
    if (selectedOptions.length >= optionLimit) return
    setOptions([...selectedOptions, key])
  }

  return (
    <div className="py-3">
      <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr] items-start gap-2 sm:gap-3">
        <span
          className="text-[11px] tracking-[0.15em] sm:pt-1"
          style={{ color: paletteVar("text"), opacity: 0.7 }}
        >
          BOTTOM BAR
        </span>
        <div className="space-y-2 min-w-0">
          <div
            className="grid gap-px overflow-hidden"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))",
              border: `1px solid ${color}44`,
            }}
          >
            {current.map((key) => {
              const locked = key === "home" || key === "more"
              return (
                <div
                  key={key}
                  className="px-2 py-1.5 text-center min-w-0"
                  style={{
                    background: locked ? `${color}18` : `${paletteVar("zec")}14`,
                    color: locked ? color : paletteVar("zec"),
                    borderRight:
                      key !== current[current.length - 1]
                        ? `1px solid ${paletteVar("text")}22`
                        : undefined,
                  }}
                >
                  <div className="text-[10px] sm:text-[11px] font-bold tracking-[0.08em] sm:tracking-[0.12em] truncate">
                    {BUTTON_BAR_LABELS[key]}
                  </div>
                  <div
                    className="text-[9px] tracking-[0.12em]"
                    style={{ opacity: 0.55 }}
                  >
                    {locked ? "LOCKED" : "SLOT"}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[10px] tracking-[0.12em]"
              style={{ color: paletteVar("text"), opacity: 0.55 }}
            >
              {selectedCount}/{optionLimit} OPTIONAL
            </span>
            <button
              type="button"
              onClick={() => setOptions(["rank", "port"])}
              className="px-2 py-1 text-[10px] tracking-[0.14em] transition-colors"
              style={{
                color,
                border: `1px solid ${color}44`,
                background: "transparent",
              }}
            >
              DEFAULT
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {BUTTON_BAR_OPTION_KEYS.map((key) => {
              const on = selectedOptions.includes(key)
              const disabled = !on && selectedOptions.length >= optionLimit
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => toggleOption(key)}
                  className="px-2 py-1 text-[11px] tracking-[0.1em] transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: on ? `${paletteVar("zec")}1a` : "transparent",
                    color: on ? paletteVar("zec") : paletteVar("text"),
                    opacity: disabled ? 0.28 : on ? 1 : 0.58,
                    border: `1px solid ${on ? `${paletteVar("zec")}66` : `${paletteVar("text")}33`}`,
                  }}
                >
                  {BUTTON_BAR_LABELS[key]}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function HeaderBarManager({
  value,
  onChange,
}: {
  value: HeaderBarKey[]
  onChange: (v: HeaderBarKey[]) => void
}) {
  const current = sanitizeHeaderBar(value)
  const selectedOptions = current.filter((k): k is HeaderBarOptionKey =>
    HEADER_BAR_OPTION_KEYS.includes(k as HeaderBarOptionKey)
  )
  const color = paletteVar("cyph")

  const setOptions = (options: HeaderBarOptionKey[]) => {
    onChange(sanitizeHeaderBar(["home", ...options, "updates", "settings"]))
  }

  const toggleOption = (key: HeaderBarOptionKey) => {
    const on = selectedOptions.includes(key)
    if (on) {
      setOptions(selectedOptions.filter((k) => k !== key))
      return
    }
    if (selectedOptions.length >= HEADER_BAR_MAX_OPTIONS) return
    setOptions([...selectedOptions, key])
  }

  return (
    <div className="py-3">
      <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr] items-start gap-2 sm:gap-3">
        <span
          className="text-[11px] tracking-[0.15em] sm:pt-1"
          style={{ color: paletteVar("text"), opacity: 0.7 }}
        >
          HEADER BAR
        </span>
        <div className="space-y-2 min-w-0">
          <div
            className="grid gap-px overflow-hidden"
            style={{
              gridTemplateColumns: `repeat(${current.length}, minmax(0, 1fr))`,
              border: `1px solid ${color}44`,
            }}
          >
            {current.map((key) => {
              const locked = key === "home" || key === "updates" || key === "settings"
              return (
                <div
                  key={key}
                  className="px-2 py-1.5 text-center min-w-0"
                  style={{
                    background: locked ? `${color}18` : `${paletteVar("zec")}14`,
                    color: locked ? color : paletteVar("zec"),
                    borderRight:
                      key !== current[current.length - 1]
                        ? `1px solid ${paletteVar("text")}22`
                        : undefined,
                  }}
                >
                  <div className="text-[10px] sm:text-[11px] font-bold tracking-[0.08em] sm:tracking-[0.12em] truncate">
                    {HEADER_BAR_LABELS[key]}
                  </div>
                  <div
                    className="text-[9px] tracking-[0.12em]"
                    style={{ opacity: 0.55 }}
                  >
                    {locked ? "LOCKED" : "HEADING"}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[10px] tracking-[0.12em]"
              style={{ color: paletteVar("text"), opacity: 0.55 }}
            >
              {selectedOptions.length}/{HEADER_BAR_MAX_OPTIONS} HEADINGS
              <span className="ml-2 opacity-70">
                DASHBOARD + UPDATES + SETTINGS LOCKED
              </span>
            </span>
            <button
              type="button"
              onClick={() =>
                setOptions(["rank", "shielding", "port", "est", "trsy"])
              }
              className="px-2 py-1 text-[10px] tracking-[0.14em] transition-colors"
              style={{
                color,
                border: `1px solid ${color}44`,
                background: "transparent",
              }}
            >
              DEFAULT
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {HEADER_BAR_OPTION_KEYS.map((key) => {
              const on = selectedOptions.includes(key)
              const disabled = !on && selectedOptions.length >= HEADER_BAR_MAX_OPTIONS
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => toggleOption(key)}
                  className="px-2 py-1 text-[11px] tracking-[0.1em] transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: on ? `${paletteVar("zec")}1a` : "transparent",
                    color: on ? paletteVar("zec") : paletteVar("text"),
                    opacity: disabled ? 0.28 : on ? 1 : 0.58,
                    border: `1px solid ${on ? `${paletteVar("zec")}66` : `${paletteVar("text")}33`}`,
                  }}
                >
                  {HEADER_BAR_LABELS[key]}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function DashboardTilesManager({
  value,
  onChange,
  portfolioReady,
}: {
  value: DashboardTileKey[]
  onChange: (v: DashboardTileKey[]) => void
  portfolioReady: boolean
}) {
  const saved = sanitizeDashboardTiles(value)
  const currentBase = portfolioReady
    ? saved
    : saved.filter((key) => key !== "portfolio")
  const current =
    currentBase.length > 0
      ? currentBase
      : sanitizeDashboardTiles(null).filter((key) => key !== "portfolio")
  const color = paletteVar("ratio")

  const setTiles = (tiles: DashboardTileKey[]) => {
    const allowed = portfolioReady
      ? tiles
      : tiles.filter((key) => key !== "portfolio")
    onChange(sanitizeDashboardTiles(allowed))
  }

  const toggle = (key: DashboardTileKey) => {
    const on = current.includes(key)
    if (on) {
      if (current.length <= 1) return
      setTiles(current.filter((item) => item !== key))
      return
    }
    setTiles([...current, key])
  }

  const move = (key: DashboardTileKey, direction: -1 | 1) => {
    const index = current.indexOf(key)
    if (index < 0) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= current.length) return
    const next = [...current]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    setTiles(next)
  }

  return (
    <div className="py-3">
      <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr] items-start gap-2 sm:gap-3">
        <span
          className="text-[11px] tracking-[0.15em] sm:pt-1"
          style={{ color: paletteVar("text"), opacity: 0.7 }}
        >
          DASHBOARD
        </span>
        <div className="space-y-2 min-w-0">
          <div
            className="text-[10px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.58 }}
          >
            Pick which cards appear on Dashboard, then move selected cards earlier
            or later. At least one tile stays on.
          </div>

          <div
            className="flex flex-wrap gap-1.5"
            aria-label="Dashboard tile visibility"
          >
            {DASHBOARD_TILE_KEYS.map((key) => {
              const on = current.includes(key)
              const unavailable = key === "portfolio" && !portfolioReady
              const disableOff = on && current.length <= 1
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={disableOff || unavailable}
                  onClick={() => toggle(key)}
                  className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-bold tracking-[0.12em] transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: on ? `${color}18` : "transparent",
                    color: unavailable ? paletteVar("amber") : on ? color : paletteVar("text"),
                    opacity: unavailable ? 0.5 : disableOff ? 0.72 : on ? 1 : 0.55,
                    border: `1px solid ${on ? `${color}66` : `${paletteVar("text")}33`}`,
                  }}
                >
                  <span
                    className="inline-flex size-3 items-center justify-center border"
                    style={{
                      borderColor: on ? color : `${paletteVar("text")}44`,
                      background: on ? color : "transparent",
                      color: "#000",
                    }}
                  >
                    {on && <Check size={10} strokeWidth={3} />}
                  </span>
                  {DASHBOARD_TILE_LABELS[key]}
                  {unavailable && <span>LOCKED</span>}
                </button>
              )
            })}
          </div>

          <div
            className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-4"
          >
            {current.map((key, index) => (
              <div
                key={key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border px-2 py-2 min-w-0"
                style={{
                  background: `${color}10`,
                  borderColor: `${color}44`,
                }}
              >
                <span
                  className="inline-flex size-6 items-center justify-center border text-[11px] font-bold tabular-nums"
                  style={{
                    borderColor: `${color}66`,
                    color,
                    background: `${color}12`,
                  }}
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-bold tracking-[0.14em]" style={{ color }}>
                    {DASHBOARD_TILE_LABELS[key]}
                  </div>
                  <div
                    className="text-[9px] tracking-[0.12em]"
                    style={{ color: paletteVar("text"), opacity: 0.52 }}
                  >
                    TILE ORDER
                  </div>
                </div>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(key, -1)}
                    disabled={index <= 0}
                    className="inline-flex size-7 items-center justify-center border disabled:opacity-25"
                    style={{ borderColor: `${color}44`, color }}
                    aria-label={`Move ${DASHBOARD_TILE_LABELS[key]} earlier`}
                    title="Move earlier"
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(key, 1)}
                    disabled={index === current.length - 1}
                    className="inline-flex size-7 items-center justify-center border disabled:opacity-25"
                    style={{ borderColor: `${color}44`, color }}
                    aria-label={`Move ${DASHBOARD_TILE_LABELS[key]} later`}
                    title="Move later"
                  >
                    <ArrowRight size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className="text-[10px] tracking-[0.12em]"
              style={{ color: paletteVar("text"), opacity: 0.55 }}
            >
              {current.length}/{DASHBOARD_TILE_KEYS.length} TILES
            </span>
            {!portfolioReady && !current.includes("portfolio") && (
              <span
                className="min-w-0 flex-1 text-[10px] tracking-[0.12em]"
                style={{ color: paletteVar("amber") }}
              >
                PORTFOLIO UNLOCKS AFTER SAVING HOLDINGS
              </span>
            )}
            <button
              type="button"
              onClick={() => setTiles([...DASHBOARD_TILE_DEFAULT_KEYS])}
              className="px-2 py-1 text-[10px] tracking-[0.14em] transition-colors"
              style={{
                color,
                border: `1px solid ${color}44`,
                background: "transparent",
              }}
            >
              DEFAULT
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Settings() {
  const [s, setSetting, reset] = useCyphzecSettings()
  const [portfolio, , , portfolioHydrated] = usePortfolioState()
  const portfolioReady = portfolioHydrated && hasPortfolioData(portfolio)
  const saved = useSavedPulse(s)
  // Tiny live preview — uses the same /api/prices?days=7 series the
  // dashboard subscribes to so SWR dedupes a single fetch.
  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=7",
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )

  const toggleChip = (k: TickerChipKey) => {
    const current = s.tickerChips ?? []
    const next = current.includes(k)
      ? current.filter((c) => c !== k)
      : [...current, k]
    setSetting("tickerChips", next)
  }
  const history = prices?.history ?? []
  const cyphSpark = history.flatMap((h) => (h.cyph != null ? [h.cyph] : []))
  const zecSpark = history.map((h) => h.zec)
  const ratioSpark = history.flatMap((h) => (h.ratio != null ? [h.ratio] : []))
  const cyphPrice =
    [...history].reverse().find((h) => h.cyph != null)?.cyph ?? null
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
          className="text-[11px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          preferences saved on-device
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 transition-opacity"
          style={{
            color: paletteVar("cyph"),
            border: `1px solid ${paletteVar("cyph")}55`,
            opacity: saved ? 1 : 0.4,
          }}
        >
          <LED color={paletteVar("cyph")} size={4} /> {saved ? "SAVED" : "AUTOSAVED"}
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
          label="DASHBOARD TILES"
          color={paletteVar("ratio")}
          style={{ gridColumn: "1 / -1" }}
        >
          <DashboardTilesManager
            value={s.dashboardTiles}
            portfolioReady={portfolioReady}
            onChange={(v) => setSetting("dashboardTiles", v)}
          />
        </CornerBox>

        <CornerBox
          label="NAVIGATION"
          color={paletteVar("cyph")}
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="md:hidden">
            <ButtonBarManager
              value={s.buttonBar}
              onChange={(v) => setSetting("buttonBar", v)}
            />
          </div>
          <div className="hidden md:block">
            <HeaderBarManager
              value={s.headerBar}
              onChange={(v) => setSetting("headerBar", v)}
            />
          </div>
        </CornerBox>

        {/* TICKER TAPE - full-width row so chip toggles wrap cleanly. */}
        <CornerBox
          label="TICKER TAPE"
          color={paletteVar("zec")}
          style={{ gridColumn: "1 / -1" }}
        >
          <ToggleRow
            label="TICKER"
            value={s.ticker}
            onChange={(v) => setSetting("ticker", v)}
          />
          <SliderRow
            label="SPEED"
            value={s.tickerSpeed}
            min={1}
            max={5}
            step={1}
            unit=""
            color={paletteVar("zec")}
            onChange={(v) => setSetting("tickerSpeed", v)}
            disabled={s.motion === "off"}
            hint={s.motion === "off" ? "motion off" : undefined}
          />
          <div className="grid grid-cols-[110px_1fr] items-start gap-3 py-3">
            <span
              className="text-[11px] tracking-[0.15em] pt-1.5"
              style={{ color: paletteVar("text"), opacity: 0.7 }}
            >
              CHIPS
            </span>
            <div className="flex flex-wrap gap-1.5">
              {TICKER_CHIP_KEYS.map((k) => {
                const on = (s.tickerChips ?? []).includes(k)
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleChip(k)}
                    aria-pressed={on}
                    className="px-2 py-1 text-[11px] tracking-[0.1em] transition-colors"
                    style={{
                      background: on
                        ? `${paletteVar("zec")}1a`
                        : "transparent",
                      color: on ? paletteVar("zec") : paletteVar("text"),
                      opacity: on ? 1 : 0.55,
                      border: `1px solid ${on ? `${paletteVar("zec")}66` : `${paletteVar("text")}33`}`,
                    }}
                  >
                    {CHIP_LABELS[k]}
                  </button>
                )
              })}
            </div>
          </div>
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
                    className="text-[11px] tracking-[0.3em] font-bold"
                    style={{
                      color: c.color,
                      textShadow: `0 0 6px ${c.color}55`,
                    }}
                  >
                    {c.label}
                  </span>
                  <span
                    className="text-[10px]"
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
          className="text-[11px]"
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
