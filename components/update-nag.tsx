"use client"

import { useVersionCheck } from "@/hooks/use-version-check"
import { paletteVar } from "./theme"

export function UpdateNag() {
  const { hasUpdate, latestVersion, dismiss, refresh } = useVersionCheck()

  if (!hasUpdate) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-0 left-0 right-0 z-50 border-t px-3 py-2 md:px-4 md:py-2.5"
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
            A new version is available
            {latestVersion ? ` (${latestVersion.slice(0, 7)})` : ""}.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="px-2.5 py-1 text-[10px] md:text-[11px] font-bold tracking-wider transition-colors hover:opacity-90"
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
            className="px-2 py-1 text-[10px] md:text-[11px] tracking-wider transition-colors hover:opacity-80"
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
