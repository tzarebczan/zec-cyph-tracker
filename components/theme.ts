"use client"

// Cypherpunk-terminal theme primitives for the beta redesign.
// Palette tokens + named CSS-variable bridge so `applySettings` can
// retint everything (CornerBox, LED, PhosphorSpark, …) by changing
// the six values stored under `--cz-cyph`, `--cz-zec`, etc.
//
// Default palette is "emerald" — matches the previous design language
// (#34d399 / #fde047 / #67e8f9). Other palettes live in `palettes.ts`.
export interface Palette {
  cyph: string
  zec: string
  ratio: string
  text: string
  dim: string
  amber: string
}

export const DEFAULT_PALETTE: Palette = {
  cyph: "#34d399",
  zec: "#fde047",
  ratio: "#67e8f9",
  text: "#86efac",
  dim: "#22c55e",
  amber: "#fbbf24",
}

// Static colors that don't shift across palettes.
export const E_STATIC = {
  red: "#f87171",
  bg: "#000000",
}

/** Read a palette token from CSS variables so primitives stay reactive
 *  when the user changes palette in Settings. Falls back to the
 *  emerald default during SSR (no `window`). */
export function paletteVar(token: keyof Palette): string {
  return `var(--cz-${token}, ${DEFAULT_PALETTE[token]})`
}

/**
 * A colour at a given alpha, `pct` in 0..100.
 *
 * Use this instead of concatenating a hex-alpha suffix onto `paletteVar()`.
 * `var()` substitution is token-based, so `var(--cz-cyph, #34d399)33` stays
 * two separate tokens and the declaration is dropped — silently for
 * backgrounds and shadows, and misleadingly for `border-color`, which then
 * falls back to `currentColor` at full strength. `color-mix` composites for
 * real, and works inside gradients and text shadows too.
 */
export function withAlpha(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}
