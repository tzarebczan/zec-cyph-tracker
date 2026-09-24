// Appearance settings that both the client settings hook and the server
// need to agree on. `use-cyphzec-settings.ts` is a "use client" module, and
// a server component importing it would get client references instead of
// values, so anything the root layout's inline head script needs to embed
// (storage key, enums, defaults, font scale) lives here, directive-free.

export const SETTINGS_STORAGE_KEY = "cyphzec.settings.v1"

export type Density = "compact" | "comfortable" | "spacious"
/** Type scale — independent of density (spacing). `small` = current default. */
export type FontSize = "xsmall" | "small" | "medium" | "large"
export type BackgroundChrome = "scanlines" | "grid" | "both" | "none"
export type Motion = "full" | "subtle" | "off"

export const DENSITIES: readonly Density[] = ["compact", "comfortable", "spacious"]
export const FONT_SIZES: readonly FontSize[] = ["xsmall", "small", "medium", "large"]
export const BACKGROUNDS: readonly BackgroundChrome[] = ["scanlines", "grid", "both", "none"]
export const MOTIONS: readonly Motion[] = ["full", "subtle", "off"]

/** Multiplier applied to the whole shell UI (fonts + fixed-px type). */
export const FONT_SIZE_SCALE: Record<FontSize, number> = {
  xsmall: 0.88,
  small: 1,
  medium: 1.1,
  large: 1.2,
}

/** The subset of settings that `applySettings` paints onto `<html>`. The
 *  head script applies exactly these before first paint so a returning
 *  user's page is laid out at their font scale and density from the first
 *  frame instead of re-flowing when React mounts. */
export const APPEARANCE_DEFAULTS = {
  palette: "emerald",
  density: "comfortable" as Density,
  fontSize: "small" as FontSize,
  background: "scanlines" as BackgroundChrome,
  vignette: true,
  glow: 70,
  motion: "full" as Motion,
}
