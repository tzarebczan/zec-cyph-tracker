"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { removeReloadParam } from "@/lib/clean-client-reload"
import { usePersistentState } from "@/lib/use-persistent-state"

interface VersionInfo {
  version: string
  builtAt: string
}

const POLL_INTERVAL_MS = 60_000
const INITIAL_DELAY_MS = 5_000
// Foregrounding a tab fires `focus`, `visibilitychange` and often `pageshow`
// within the same tick; one check covers all three.
const MIN_CHECK_GAP_MS = 5_000
// Historical: an earlier refresh path appended this to the URL. Still
// stripped on load so old bookmarks and open tabs come out clean.
const REFRESH_PARAM = "__app_refresh"

// True once /api/version has reported a build other than the one this page
// was served with. Set the moment the check returns rather than in an effect,
// so a pointer-up in the same frame already sees it. The bottom dock reads it
// because it navigates on pointer-up, before the click the effect below
// intercepts.
let shellStale = false
// The href a stale-shell navigation was just issued for, so pointer-up and
// the click that follows it do not each call location.assign.
let staleNavigation: { href: string; at: number } | null = null

/** Whether a newer build is live than the one this document came from. */
export function isShellStale(): boolean {
  return shellStale
}

/** Full navigation for a stale shell. A repeat for the same href within a
 *  second is ignored so pointer-up and click do not both navigate. */
export function navigateStaleShell(href: string): void {
  const now = Date.now()
  if (
    staleNavigation &&
    staleNavigation.href === href &&
    now - staleNavigation.at < 1_000
  ) {
    return
  }
  staleNavigation = { href, at: now }
  window.location.assign(href)
}

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
 * The alert is per-version dismissible via `dismiss`, and `refresh` reloads
 * the page.
 *
 * Neither the refresh nor the stale-shell navigation below clears the
 * service worker or its caches any more. Every chunk URL is content-hashed
 * and carries the deployment id, so a cache from the previous build can
 * never be served against the new shell; clearing it only made the next
 * load re-download everything and re-register the worker. Recovery from a
 * genuinely broken chunk set stays with ChunkErrorRecovery, which does
 * clear caches, because there the cache is the suspect.
 */
export function useVersionCheck() {
  const initialVersion = useRef(getInitialVersion())
  const [latest, setLatest] = useState<VersionInfo | null>(null)
  const [dismissedVersion, setDismissedVersion] = usePersistentState<string | null>(
    "cyphzec.update-nag.dismissed",
    null,
    (v): v is string | null => v === null || typeof v === "string"
  )

  const lastCheckAt = useRef(0)
  const check = useCallback(async () => {
    const now = Date.now()
    if (now - lastCheckAt.current < MIN_CHECK_GAP_MS) return null
    lastCheckAt.current = now
    try {
      const info = await fetchLatestVersion()
      if (initialVersion.current != null && info.version !== initialVersion.current) {
        shellStale = true
      }
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

  const refresh = useCallback(() => {
    if (typeof window === "undefined") return
    window.location.reload()
  }, [])

  useEffect(() => {
    if (!hasVersionMismatch) return
    shellStale = true
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
      // A link to the page already showing (the dock's active tab, the
      // brand on the home page) is left alone: the dock only scrolls to the
      // top for it, and reloading here made that tap blink.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return
      }
      // A client-side navigation on a stale shell would ask for chunks the
      // new deployment no longer serves, so make it a full navigation to
      // the page the user actually clicked. This used to reload the
      // current page instead, which swallowed the click: after every
      // deploy, the first tap on any tab left the user where they were.
      event.preventDefault()
      navigateStaleShell(url.toString())
    }
    document.addEventListener("click", onClick, true)
    return () => {
      shellStale = false
      document.removeEventListener("click", onClick, true)
    }
  }, [hasVersionMismatch])

  return { hasUpdate, dismiss, refresh }
}

// Extend the global Window interface for the inline version marker.
declare global {
  interface Window {
    __APP_VERSION__?: string
  }
}
