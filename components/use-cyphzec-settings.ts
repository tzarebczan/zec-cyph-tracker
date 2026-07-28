"use client"

import { useCallback, useEffect, useState } from "react"
import { E_PALETTES, type PaletteName } from "./palettes"

const STORAGE_KEY = "cyphzec.settings.v1"

export type Density = "compact" | "comfortable" | "spacious"
/** Type scale — independent of density (spacing). `small` = current default. */
export type FontSize = "xsmall" | "small" | "medium" | "large"
export type BackgroundChrome = "scanlines" | "grid" | "both" | "none"
export type Motion = "full" | "subtle" | "off"

// Available ticker chip keys. Order matters — the Settings page renders
// chip toggles in this order so the row layout stays stable when users
// add/remove chips. Headline trio (cyph/zec/ratio) is excluded by
// default because the dashboard tiles already show those numbers
// above the fold; users can opt them in via Settings.
export const TICKER_CHIP_KEYS = [
  "btc",
  "eth",
  "sol",
  "xrp",
  "ada",
  "avax",
  "doge",
  "hype",
  "near",
  "spx",
  "ndx",
  "dji",
  "mstr",
  "coin",
  "dxy",
  "gold",
  "vix",
] as const
export type TickerChipKey = (typeof TICKER_CHIP_KEYS)[number]
const VALID_TICKER_CHIPS = new Set<string>(TICKER_CHIP_KEYS)

export const TICKER_DEFAULT_CHIPS: TickerChipKey[] = [
  "btc",
  "eth",
  "sol",
  "xrp",
  "ada",
  "avax",
  "hype",
  "near",
  "spx",
  "ndx",
  "dji",
  "mstr",
  "coin",
  "dxy",
  "gold",
  "vix",
]

export const BUTTON_BAR_MAX_ITEMS = 5
export const BUTTON_BAR_FIXED_KEYS = ["home", "more"] as const
export const BUTTON_BAR_OPTION_KEYS = [
  "rank",
  "bitcoin",
  "shielding",
  "exchanges",
  "port",
  "est",
  "trsy",
  "whatif",
  "updates",
  "about",
  "settings",
] as const
export type ButtonBarFixedKey = (typeof BUTTON_BAR_FIXED_KEYS)[number]
export type ButtonBarOptionKey = (typeof BUTTON_BAR_OPTION_KEYS)[number]
export type ButtonBarKey = ButtonBarFixedKey | ButtonBarOptionKey
const VALID_BUTTON_BAR_KEYS = new Set<string>([
  ...BUTTON_BAR_FIXED_KEYS,
  ...BUTTON_BAR_OPTION_KEYS,
])

export const BUTTON_BAR_DEFAULT_KEYS: ButtonBarKey[] = [
  "home",
  "rank",
  "exchanges",
  "port",
  "more",
]

export const HEADER_BAR_MAX_OPTIONS = 5
export const HEADER_BAR_FIXED_KEYS = ["home", "bitcoin", "updates", "settings"] as const
export const HEADER_BAR_OPTION_KEYS = [
  "rank",
  "shielding",
  "port",
  "est",
  "trsy",
  "about",
] as const
export type HeaderBarFixedKey = (typeof HEADER_BAR_FIXED_KEYS)[number]
export type HeaderBarOptionKey = (typeof HEADER_BAR_OPTION_KEYS)[number]
export type HeaderBarKey = HeaderBarFixedKey | HeaderBarOptionKey
const VALID_HEADER_BAR_KEYS = new Set<string>([
  ...HEADER_BAR_FIXED_KEYS,
  ...HEADER_BAR_OPTION_KEYS,
])

export const HEADER_BAR_DEFAULT_KEYS: HeaderBarKey[] = [
  "home",
  "rank",
  "shielding",
  "port",
  "est",
  "trsy",
  "updates",
  "settings",
]

export const DASHBOARD_TILE_KEYS = [
  "cyph",
  "zec",
  "ratio",
  "portfolio",
] as const
export type DashboardTileKey = (typeof DASHBOARD_TILE_KEYS)[number]
const VALID_DASHBOARD_TILE_KEYS = new Set<string>(DASHBOARD_TILE_KEYS)
export const DASHBOARD_TILE_DEFAULT_KEYS: DashboardTileKey[] = [
  "cyph",
  "zec",
  "ratio",
]

export interface CyphzecSettings {
  palette: PaletteName
  density: Density
  fontSize: FontSize
  background: BackgroundChrome
  vignette: boolean
  glow: number // 0..100
  motion: Motion
  ticker: boolean
  tickerSpeed: number // 1..5
  tickerChips: TickerChipKey[]
  buttonBar: ButtonBarKey[]
  headerBar: HeaderBarKey[]
  dashboardTiles: DashboardTileKey[]
  /** Ironwood countdown / migration banner above the readout grid.
   *  Deliberately a defaulted boolean rather than a `dashboardTiles` key:
   *  the tiles array is already persisted for existing users, so a new
   *  opt-in key would stay hidden for everyone who has ever opened
   *  Settings. Absent from stored JSON ⇒ falls through to `true`. */
  ironwoodBanner: boolean
}

export const CYPHZEC_DEFAULTS: CyphzecSettings = {
  palette: "emerald",
  density: "comfortable",
  fontSize: "small",
  background: "scanlines",
  vignette: true,
  glow: 70,
  motion: "full",
  ticker: true,
  tickerSpeed: 3,
  tickerChips: TICKER_DEFAULT_CHIPS,
  buttonBar: BUTTON_BAR_DEFAULT_KEYS,
  headerBar: HEADER_BAR_DEFAULT_KEYS,
  dashboardTiles: DASHBOARD_TILE_DEFAULT_KEYS,
  ironwoodBanner: true,
}

/** Multiplier applied to the whole shell UI (fonts + fixed-px type). */
export const FONT_SIZE_SCALE: Record<FontSize, number> = {
  xsmall: 0.88,
  small: 1,
  medium: 1.1,
  large: 1.2,
}

let cachedSettings: CyphzecSettings | null = null

/** Push every settings value to the document root so non-React code
 *  (CSS rules, the CRT overlay, density rules) can react via plain
 *  selectors. Also bridges the active palette into the six --cz-*
 *  CSS variables that every primitive reads via `paletteVar()`. */
export function applySettings(s: CyphzecSettings) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.dataset.czTheme = "on"
  root.dataset.czDensity = s.density
  root.dataset.czFont = s.fontSize
  root.dataset.czMotion = s.motion
  root.dataset.czBg = s.background
  root.dataset.czVignette = s.vignette ? "on" : "off"
  root.style.setProperty("--cz-glow", String(s.glow / 100))
  root.style.setProperty(
    "--cz-font-scale",
    String(FONT_SIZE_SCALE[s.fontSize] ?? FONT_SIZE_SCALE.small)
  )

  const p = E_PALETTES[s.palette] ?? E_PALETTES.emerald
  root.style.setProperty("--cz-cyph", p.cyph)
  root.style.setProperty("--cz-zec", p.zec)
  root.style.setProperty("--cz-ratio", p.ratio)
  root.style.setProperty("--cz-text", p.text)
  root.style.setProperty("--cz-dim", p.dim)
  root.style.setProperty("--cz-amber", p.amber)
}

/** Strip the cz-* theme attrs / vars from the document root. Called
 *  on EShell unmount (e.g. during dev hot-reload) so a stale palette
 *  doesn't carry over if the user lands on a future page that opts out
 *  of the shell. */
export function clearSettings() {
  if (typeof document === "undefined") return
  const root = document.documentElement
  delete root.dataset.czTheme
  delete root.dataset.czDensity
  delete root.dataset.czFont
  delete root.dataset.czMotion
  delete root.dataset.czBg
  delete root.dataset.czVignette
  root.style.removeProperty("--cz-glow")
  root.style.removeProperty("--cz-font-scale")
  root.style.removeProperty("--cz-cyph")
  root.style.removeProperty("--cz-zec")
  root.style.removeProperty("--cz-ratio")
  root.style.removeProperty("--cz-text")
  root.style.removeProperty("--cz-dim")
  root.style.removeProperty("--cz-amber")
}

// Type guards used by `loadFromStorage` to reject corrupt / outdated
// values rather than letting them paint to the DOM (an invalid palette
// would leave the swatch picker unhighlighted; an invalid background
// would leave the CRT layer rules with no match and the chrome stuck).
const VALID_DENSITIES: ReadonlySet<Density> = new Set([
  "compact",
  "comfortable",
  "spacious",
])
const VALID_FONT_SIZES: ReadonlySet<FontSize> = new Set([
  "xsmall",
  "small",
  "medium",
  "large",
])
const VALID_BG: ReadonlySet<BackgroundChrome> = new Set([
  "scanlines",
  "grid",
  "both",
  "none",
])
const VALID_MOTION: ReadonlySet<Motion> = new Set(["full", "subtle", "off"])

export function sanitizeButtonBar(value: unknown): ButtonBarKey[] {
  const raw = Array.isArray(value) ? value : BUTTON_BAR_DEFAULT_KEYS
  const selected: ButtonBarOptionKey[] = []
  for (const key of raw) {
    if (
      typeof key !== "string" ||
      !VALID_BUTTON_BAR_KEYS.has(key) ||
      key === "home" ||
      key === "more" ||
      selected.includes(key as ButtonBarOptionKey)
    ) {
      continue
    }
    selected.push(key as ButtonBarOptionKey)
    if (selected.length >= BUTTON_BAR_MAX_ITEMS - BUTTON_BAR_FIXED_KEYS.length) {
      break
    }
  }
  return ["home", ...selected, "more"]
}

export function sanitizeHeaderBar(value: unknown): HeaderBarKey[] {
  const raw = Array.isArray(value) ? value : HEADER_BAR_DEFAULT_KEYS
  const selected: HeaderBarOptionKey[] = []
  for (const key of raw) {
    if (
      typeof key !== "string" ||
      !VALID_HEADER_BAR_KEYS.has(key) ||
      key === "home" ||
      key === "bitcoin" ||
      key === "updates" ||
      key === "settings" ||
      selected.includes(key as HeaderBarOptionKey)
    ) {
      continue
    }
    selected.push(key as HeaderBarOptionKey)
    if (selected.length >= HEADER_BAR_MAX_OPTIONS) break
  }
  return ["home", "bitcoin", ...selected, "updates", "settings"]
}

export function sanitizeDashboardTiles(value: unknown): DashboardTileKey[] {
  const raw = Array.isArray(value) ? value : DASHBOARD_TILE_DEFAULT_KEYS
  const selected: DashboardTileKey[] = []
  for (const key of raw) {
    if (
      typeof key !== "string" ||
      !VALID_DASHBOARD_TILE_KEYS.has(key) ||
      selected.includes(key as DashboardTileKey)
    ) {
      continue
    }
    selected.push(key as DashboardTileKey)
  }
  return selected.length > 0 ? selected : DASHBOARD_TILE_DEFAULT_KEYS
}

function sanitize(parsed: Partial<CyphzecSettings>): CyphzecSettings {
  const out: CyphzecSettings = { ...CYPHZEC_DEFAULTS }
  if (typeof parsed.palette === "string" && parsed.palette in E_PALETTES) {
    out.palette = parsed.palette as PaletteName
  }
  if (typeof parsed.density === "string" && VALID_DENSITIES.has(parsed.density as Density)) {
    out.density = parsed.density as Density
  }
  if (
    typeof parsed.fontSize === "string" &&
    VALID_FONT_SIZES.has(parsed.fontSize as FontSize)
  ) {
    out.fontSize = parsed.fontSize as FontSize
  }
  if (
    typeof parsed.background === "string" &&
    VALID_BG.has(parsed.background as BackgroundChrome)
  ) {
    out.background = parsed.background as BackgroundChrome
  }
  if (typeof parsed.motion === "string" && VALID_MOTION.has(parsed.motion as Motion)) {
    out.motion = parsed.motion as Motion
  }
  if (typeof parsed.vignette === "boolean") out.vignette = parsed.vignette
  if (typeof parsed.ironwoodBanner === "boolean") {
    out.ironwoodBanner = parsed.ironwoodBanner
  }
  if (typeof parsed.glow === "number" && Number.isFinite(parsed.glow)) {
    out.glow = Math.max(0, Math.min(100, parsed.glow))
  }
  if (typeof parsed.ticker === "boolean") out.ticker = parsed.ticker
  if (typeof parsed.tickerSpeed === "number" && Number.isFinite(parsed.tickerSpeed)) {
    out.tickerSpeed = Math.max(1, Math.min(5, Math.round(parsed.tickerSpeed)))
  }
  if (Array.isArray(parsed.tickerChips)) {
    // Drop unknown chip keys silently rather than reject the whole
    // tickerChips field — that way a future-version chip set degrades
    // gracefully when an older client loads it.
    const cleaned = parsed.tickerChips.filter(
      (k): k is TickerChipKey =>
        typeof k === "string" && VALID_TICKER_CHIPS.has(k)
    )
    out.tickerChips = cleaned
  }
  out.buttonBar = sanitizeButtonBar(parsed.buttonBar)
  out.headerBar = sanitizeHeaderBar(parsed.headerBar)
  out.dashboardTiles = sanitizeDashboardTiles(parsed.dashboardTiles)
  return out
}

function loadFromStorage(): CyphzecSettings {
  if (typeof window === "undefined") return CYPHZEC_DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return CYPHZEC_DEFAULTS
    return sanitize(JSON.parse(raw) as Partial<CyphzecSettings>)
  } catch {
    return CYPHZEC_DEFAULTS
  }
}

/** localStorage-backed settings hook. Saves automatically, applies
 *  to `<html>` on every change, and broadcasts an event so other
 *  mounted instances (e.g. the Settings page + a Tweaks overlay)
 *  stay in sync. The first client mount starts from defaults, then
 *  route remounts reuse the in-memory value to avoid a default-settings
 *  flash while localStorage is read again. */
export function useCyphzecSettings(): [
  CyphzecSettings,
  <K extends keyof CyphzecSettings>(key: K, value: CyphzecSettings[K]) => void,
  () => void,
] {
  const [s, setS] = useState<CyphzecSettings>(
    () => cachedSettings ?? CYPHZEC_DEFAULTS
  )
  const [hydrated, setHydrated] = useState(false)

  // Initial mount: read storage + paint.
  useEffect(() => {
    const next = loadFromStorage()
    cachedSettings = next
    setS(next)
    applySettings(next)
    setHydrated(true)
  }, [])

  // Persist + broadcast on change (skip the first render — that's
  // the hydration commit which we already handled above).
  useEffect(() => {
    if (!hydrated) return
    cachedSettings = s
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      /* quota / private mode — non-fatal */
    }
    applySettings(s)
    window.dispatchEvent(new CustomEvent("cyphzec:settings", { detail: s }))
  }, [s, hydrated])

  // Sync if another component fires the in-tab broadcast event.
  useEffect(() => {
    const onSync = (e: Event) => {
      const next = (e as CustomEvent<CyphzecSettings>).detail
      if (!next) return
      setS((prev) => {
        for (const k of Object.keys(next) as (keyof CyphzecSettings)[]) {
          if (prev[k] !== next[k]) {
            cachedSettings = next
            return next
          }
        }
        return prev
      })
    }
    window.addEventListener("cyphzec:settings", onSync)
    return () => window.removeEventListener("cyphzec:settings", onSync)
  }, [])

  // Cross-tab sync — `storage` events fire when *another* tab on the
  // same origin writes to localStorage. Without this listener, opening
  // the beta site in two tabs and changing the palette in tab A leaves
  // tab B stuck on the old value until refresh.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      try {
        const next = e.newValue
          ? sanitize(JSON.parse(e.newValue) as Partial<CyphzecSettings>)
          : CYPHZEC_DEFAULTS
        setS(next)
        cachedSettings = next
      } catch {
        /* malformed payload from another tab — ignore */
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const setSetting = useCallback(
    <K extends keyof CyphzecSettings>(key: K, value: CyphzecSettings[K]) => {
      setS((prev) => {
        const next = { ...prev, [key]: value }
        cachedSettings = next
        return next
      })
    },
    []
  )
  const reset = useCallback(() => {
    const next = { ...CYPHZEC_DEFAULTS }
    cachedSettings = next
    setS(next)
  }, [])

  return [s, setSetting, reset]
}
