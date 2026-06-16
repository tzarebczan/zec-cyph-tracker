"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  cleanClientReload,
  removeReloadParam,
} from "@/lib/clean-client-reload"
import { usePersistentState } from "@/lib/use-persistent-state"

interface VersionInfo {
  version: string
  builtAt: string
}

const POLL_INTERVAL_MS = 60_000
const INITIAL_DELAY_MS = 5_000
const REFRESH_PARAM = "__app_refresh"

function getInitialVersion(): string | null {
  if (typeof window === "undefined") return null
  return (
    window.__APP_VERSION__ ??
    document.querySelector('meta[name="app-version"]')?.getAttribute("content") ??
    null
  )
}

async function fetchLatestVersion(): Promise<VersionInfo> {
  const res = await fetch(`/api/version?t=${Date.now()}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Version check failed: ${res.status}`)
  return (await res.json()) as VersionInfo
}

/**
 * Detect when a new build has been deployed. Returns `hasUpdate` once the
 * live `/api/version` differs from the version this page was built with.
 * The alert is per-version dismissible via `dismiss`, and `refresh` performs
 * a clean reload that bypasses the service worker cache.
 */
export function useVersionCheck() {
  const initialVersion = useRef(getInitialVersion())
  const [latest, setLatest] = useState<VersionInfo | null>(null)
  const [dismissedVersion, setDismissedVersion] = usePersistentState<string | null>(
    "cyphzec.update-nag.dismissed",
    null,
    (v): v is string | null => v === null || typeof v === "string"
  )

  const check = useCallback(async () => {
    try {
      const info = await fetchLatestVersion()
      setLatest(info)
      return info
    } catch (err) {
      // Silently ignore network errors; we'll try again on the next poll.
      console.warn("[version-check] Failed to fetch version:", err)
      return null
    }
  }, [])

  useEffect(() => {
    removeReloadParam(REFRESH_PARAM)
    // Give the page a moment to settle before the first background check.
    const initialTimer = setTimeout(check, INITIAL_DELAY_MS)
    const interval = setInterval(check, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void check()
    }
    const onActive = () => void check()
    window.addEventListener("focus", onActive)
    window.addEventListener("online", onActive)
    window.addEventListener("pageshow", onActive)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearTimeout(initialTimer)
      clearInterval(interval)
      window.removeEventListener("focus", onActive)
      window.removeEventListener("online", onActive)
      window.removeEventListener("pageshow", onActive)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [check])

  const currentVersion = initialVersion.current
  const hasUpdate =
    currentVersion != null &&
    latest != null &&
    latest.version !== currentVersion &&
    latest.version !== dismissedVersion
  const hasVersionMismatch =
    currentVersion != null && latest != null && latest.version !== currentVersion

  const dismiss = useCallback(() => {
    if (latest) setDismissedVersion(latest.version)
  }, [latest, setDismissedVersion])

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return
    await cleanClientReload(REFRESH_PARAM)
  }, [])

  useEffect(() => {
    if (!hasVersionMismatch) return
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== "_self") return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      event.preventDefault()
      void cleanClientReload(REFRESH_PARAM)
    }
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [hasVersionMismatch])

  return { hasUpdate, dismiss, refresh }
}

// Extend the global Window interface for the inline version marker.
declare global {
  interface Window {
    __APP_VERSION__?: string
  }
}
