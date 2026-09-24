"use client"

import { useVersionCheck } from "@/hooks/use-version-check"
import { paletteVar } from "./theme"

export function UpdateNag() {
  const { hasUpdate, dismiss, refresh } = useVersionCheck()

  if (!hasUpdate) return null

  return (
    // On phones the bar sits above the bottom dock instead of on top of it:
    // pinned to bottom-0 it covered the tabs (two lines of text plus the
    // buttons is taller than the dock), so after every deploy the navigation
    // was dead until the user pressed REFRESH or DISMISS. The dock is 50 px
    // plus the safe-area inset, but it lives inside `.cz-app`, which is
    // zoomed by the font-size setting, and this bar does not, so the offset
    // is scaled by the same variable. Compact density's 44 px dock leaves a
    // small gap rather than an overlap.
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-[calc((50px_+_env(safe-area-inset-bottom,8px))_*_var(--cz-font-scale,1))] md:bottom-0 left-0 right-0 z-50 border-t px-3 py-2 md:px-4 md:py-2.5"
      style={{
        background: "#000",
        borderColor: `${paletteVar("cyph")}66`,
      }}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] md:text-xs">
          <span
            className="inline-block h-2 w-2 rounded-full animate-pulse"
            style={{ background: paletteVar("cyph") }}
          />
          <span style={{ color: paletteVar("text") }}>
            A new version is available.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="px-2.5 py-1 text-[11px] md:text-[11px] font-bold tracking-wider transition-colors hover:opacity-90"
            style={{
              background: paletteVar("cyph"),
              color: "#000",
            }}
          >
            REFRESH
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="px-2 py-1 text-[11px] md:text-[11px] tracking-wider transition-colors hover:opacity-80"
            style={{
              color: paletteVar("text"),
              border: `1px solid ${paletteVar("text")}33`,
            }}
          >
            DISMISS
          </button>
        </div>
      </div>
    </div>
  )
}
