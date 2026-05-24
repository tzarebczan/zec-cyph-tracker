import type { Palette } from "./theme"

// Phosphor palettes — each shifts CYPH/ratio/base text. ZEC stays
// near-amber across palettes because it's locked to the real Zcash
// brand colour.
export const E_PALETTES: Record<string, Palette> = {
  emerald: { cyph: "#34d399", zec: "#fde047", ratio: "#67e8f9", text: "#86efac", dim: "#22c55e", amber: "#fbbf24" },
  amber:   { cyph: "#fbbf24", zec: "#fde047", ratio: "#fde68a", text: "#fde68a", dim: "#f59e0b", amber: "#fbbf24" },
  violet:  { cyph: "#a78bfa", zec: "#fde047", ratio: "#22d3ee", text: "#c4b5fd", dim: "#8b5cf6", amber: "#fbbf24" },
  red:     { cyph: "#fb7185", zec: "#fde047", ratio: "#fda4af", text: "#fda4af", dim: "#ef4444", amber: "#fbbf24" },
}

export type PaletteName = keyof typeof E_PALETTES
