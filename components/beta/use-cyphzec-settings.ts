"use client"

import { useCallback, useEffect, useState } from "react"
import { E_PALETTES, type PaletteName } from "./palettes"

const STORAGE_KEY = "cyphzec.settings.v1"

export type Density = "compact" | "comfortable" | "spacious"
export type BackgroundChrome = "scanlines" | "grid" | "both" | "none"
export type Motion = "full" | "subtle" | "off"

export interface CyphzecSettings {
  palette: PaletteName
  density: Density
  background: BackgroundChrome
  vignette: boolean
  glow: number // 0..100
  motion: Motion
}

export const CYPHZEC_DEFAULTS: CyphzecSettings = {
  palette: "emerald",
  density: "comfortable",
  background: "scanlines",
  vignette: true,
  glow: 70,
  motion: "full",
}

/** Push every settings value to the document root so non-React code
 *  (CSS rules, the CRT overlay, density rules) can react via plain
 *  selectors. Also bridges the active palette into the six --cz-*
 *  CSS variables that every primitive reads via `paletteVar()`. */
export function applySettings(s: CyphzecSettings) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.dataset.czTheme = "on"
  root.dataset.czDensity = s.density
  root.dataset.czMotion = s.motion
  root.dataset.czBg = s.background
  root.dataset.czVignette = s.vignette ? "on" : "off"
  root.style.setProperty("--cz-glow", String(s.glow / 100))

  const p = E_PALETTES[s.palette] ?? E_PALETTES.emerald
  root.style.setProperty("--cz-cyph", p.cyph)
  root.style.setProperty("--cz-zec", p.zec)
  root.style.setProperty("--cz-ratio", p.ratio)
  root.style.setProperty("--cz-text", p.text)
  root.style.setProperty("--cz-dim", p.dim)
  root.style.setProperty("--cz-amber", p.amber)
}

/** Strip the beta theme attrs / vars so the main site rendering on
 *  the same browser session isn't tinted by leftover settings when the
 *  user navigates away from /beta. Called on layout unmount. */
export function clearSettings() {
  if (typeof document === "undefined") return
  const root = document.documentElement
  delete root.dataset.czTheme
  delete root.dataset.czDensity
  delete root.dataset.czMotion
  delete root.dataset.czBg
  delete root.dataset.czVignette
  root.style.removeProperty("--cz-glow")
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
const VALID_BG: ReadonlySet<BackgroundChrome> = new Set([
  "scanlines",
  "grid",
  "both",
  "none",
])
const VALID_MOTION: ReadonlySet<Motion> = new Set(["full", "subtle", "off"])

function sanitize(parsed: Partial<CyphzecSettings>): CyphzecSettings {
  const out: CyphzecSettings = { ...CYPHZEC_DEFAULTS }
  if (typeof parsed.palette === "string" && parsed.palette in E_PALETTES) {
    out.palette = parsed.palette as PaletteName
  }
  if (typeof parsed.density === "string" && VALID_DENSITIES.has(parsed.density as Density)) {
    out.density = parsed.density as Density
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
  if (typeof parsed.glow === "number" && Number.isFinite(parsed.glow)) {
    out.glow = Math.max(0, Math.min(100, parsed.glow))
  }
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
 *  stay in sync. SSR-safe: starts from defaults, replaces with the
 *  stored value after mount so the server / client first paint
 *  agree. */
export function useCyphzecSettings(): [
  CyphzecSettings,
  <K extends keyof CyphzecSettings>(key: K, value: CyphzecSettings[K]) => void,
  () => void,
] {
  const [s, setS] = useState<CyphzecSettings>(CYPHZEC_DEFAULTS)
  const [hydrated, setHydrated] = useState(false)

  // Initial mount: read storage + paint.
  useEffect(() => {
    const next = loadFromStorage()
    setS(next)
    applySettings(next)
    setHydrated(true)
  }, [])

  // Persist + broadcast on change (skip the first render — that's
  // the hydration commit which we already handled above).
  useEffect(() => {
    if (!hydrated) return
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
          if (prev[k] !== next[k]) return next
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
      } catch {
        /* malformed payload from another tab — ignore */
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const setSetting = useCallback(
    <K extends keyof CyphzecSettings>(key: K, value: CyphzecSettings[K]) => {
      setS((prev) => ({ ...prev, [key]: value }))
    },
    []
  )
  const reset = useCallback(() => setS({ ...CYPHZEC_DEFAULTS }), [])

  return [s, setSetting, reset]
}
