"use client"

import { useEffect, useState } from "react"
import { usePip } from "@/components/pip-widget"
import { paletteVar } from "./theme"

// Shared button styling for the dashboard footer chips. Matches the
// terminal-style ABOUT · FAQ button on the dashboard — small, bordered,
// uppercase, hover brightens the border + tints the background. Kept
// inline (vs a reusable `EButton` component) because the dashboard is
// the only consumer of these chips today; the day a second surface
// wants the same look we lift it into primitives.tsx.
const baseClass =
  "px-2 py-1 text-[11px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40 inline-flex items-center gap-1.5"

function baseStyle(): React.CSSProperties {
  return {
    color: paletteVar("text"),
    opacity: 0.8,
    border: `1px solid ${paletteVar("text")}33`,
  }
}

// ──────────────────────────────────────────────────────────────────────
// PWA install — wraps the same beforeinstallprompt flow as the legacy
// `<PwaInstall>` but renders an E-themed bordered chip instead of the
// underlined link. Hides itself when the app is already installed and
// when no install path is available. On iOS, surfaces a short hint
// pointing at Share → Add to Home Screen (the only way to install on
// iOS Safari).
// ──────────────────────────────────────────────────────────────────────
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export function PwaInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [isIos, setIsIos] = useState(false)
  const [showIosHint, setShowIosHint] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    // Already running as a standalone PWA — render nothing.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone ===
        true
    if (standalone) {
      setInstalled(true)
      return
    }
    const ua = navigator.userAgent || ""
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes("Mac") && navigator.maxTouchPoints > 1)
    setIsIos(iOS)
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (installed) return null
  const canInstall = deferredPrompt != null || isIos
  if (!canInstall) return null

  async function handleClick() {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt()
        const choice = await deferredPrompt.userChoice
        if (choice.outcome === "accepted") setInstalled(true)
      } catch {
        /* user dismissed — leave for retry */
      } finally {
        setDeferredPrompt(null)
      }
      return
    }
    if (isIos) {
      setShowIosHint((v) => !v)
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        className={baseClass}
        style={baseStyle()}
      >
        ⬇ INSTALL
      </button>
      {showIosHint && isIos && (
        <span
          role="status"
          className="text-[11px] leading-snug max-w-[16rem]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          iOS: Safari → Share → Add to Home Screen.
        </span>
      )}
    </span>
  )
}

// ──────────────────────────────────────────────────────────────────────
// PiP pop-out — reuses the existing PipProvider context (wired in
// EShell). Renders nothing on browsers that don't support PiP. When
// the widget is open, swaps to a CLOSE button so the same chip handles
// both states.
// ──────────────────────────────────────────────────────────────────────
export function PipPopout() {
  const { supported, pipActive, restorePending, openWidget, closeWidget } =
    usePip()
  if (!supported) return null
  return (
    <button
      type="button"
      onClick={() => (pipActive ? closeWidget() : openWidget())}
      className={baseClass}
      style={baseStyle()}
      title={
        pipActive
          ? "Close the floating widget"
          : restorePending
            ? "Restore the floating widget"
            : "Open a small always-on-top widget with live prices"
      }
    >
      {pipActive ? "X CLOSE PIP" : restorePending ? "RESTORE" : "POP-OUT"}
    </button>
  )
}
