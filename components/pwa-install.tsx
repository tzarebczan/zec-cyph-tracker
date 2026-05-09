"use client"

import { useEffect, useState } from "react"
import { Download, Apple } from "lucide-react"

/**
 * Inline "Install app" link + service-worker registration.
 *
 *  - Registers /sw.js exactly once on mount, no version checking — the
 *    SW handles its own version bumping via CACHE_VERSION.
 *  - Captures the `beforeinstallprompt` event so we can fire the native
 *    install dialog on demand (Chrome / Edge / Brave / Samsung). The
 *    event is suppressed by default in our render so no banner / nag.
 *  - Hides itself once the app is already running standalone.
 *  - On iOS Safari (which never fires beforeinstallprompt) we surface a
 *    short hint pointing the user at Share → Add to Home Screen,
 *    because that's the only way to install on iOS.
 *
 * Drop this anywhere — there's no positional state. Used in the
 * dashboard's About fold where the FAQ link lives.
 */

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

    // Already running as an installed PWA — nothing to render.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // Safari pre-iOS-17 quirk
      (window.navigator as unknown as { standalone?: boolean }).standalone ===
        true
    if (standalone) {
      setInstalled(true)
      return
    }

    // Detect iOS so we can surface manual instructions there. iPadOS 13+
    // reports as Mac in user agent but has touch points, so we sniff
    // `iPad|iPhone|iPod` plus the touch hint as a fallback.
    const ua = navigator.userAgent || ""
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes("Mac") && navigator.maxTouchPoints > 1)
    setIsIos(iOS)

    // Capture the native prompt so we can fire it from the link click
    // instead of letting Chrome auto-banner.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)

    // Hide the link once installed.
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener("appinstalled", onInstalled)

    // Register the service worker. Wrapped in try/catch + load event so
    // a failed registration never breaks the page.
    if ("serviceWorker" in navigator) {
      const register = () => {
        navigator.serviceWorker
          .register("/sw.js", { scope: "/" })
          .catch((err) => {
            console.warn("[pwa] SW registration failed:", err)
          })
      }
      if (document.readyState === "complete") register()
      else window.addEventListener("load", register, { once: true })
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (installed) return null

  async function handleClick() {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt()
        const choice = await deferredPrompt.userChoice
        if (choice.outcome === "accepted") {
          setInstalled(true)
        }
      } catch {
        /* user dismissed; leave the link in place for retry */
      } finally {
        setDeferredPrompt(null)
      }
      return
    }
    if (isIos) {
      setShowIosHint((v) => !v)
      return
    }
    // Other browsers: nothing actionable, but the user clicked, so at
    // least nudge them with a brief toast-style hint via showIosHint.
    setShowIosHint((v) => !v)
  }

  // Only render the link when there's actually something we can do —
  // either we have a deferred prompt, or we're on iOS where manual
  // install is the only path. Other browsers without an install path
  // just don't see the link, no nag.
  const canInstall = deferredPrompt != null || isIos
  if (!canInstall) return null

  return (
    <span className="inline-flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 h-[22px] leading-none text-primary hover:text-primary/80 transition-colors underline-offset-2 hover:underline"
      >
        {isIos ? (
          <Apple className="h-3.5 w-3.5" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        Install app
      </button>
      {showIosHint && isIos && (
        <span
          role="status"
          className="text-[10px] text-muted-foreground/80 leading-snug max-w-[16rem] text-center"
        >
          On iOS: tap the Share button in Safari, then{" "}
          <strong>Add to Home Screen</strong>. iOS doesn&rsquo;t expose an
          install API to web pages.
        </span>
      )}
    </span>
  )
}
