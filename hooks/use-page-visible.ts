"use client"

import { useSyncExternalStore } from "react"

function subscribe(onStoreChange: () => void) {
  document.addEventListener("visibilitychange", onStoreChange)
  window.addEventListener("focus", onStoreChange)
  window.addEventListener("pageshow", onStoreChange)
  window.addEventListener("online", onStoreChange)
  return () => {
    document.removeEventListener("visibilitychange", onStoreChange)
    window.removeEventListener("focus", onStoreChange)
    window.removeEventListener("pageshow", onStoreChange)
    window.removeEventListener("online", onStoreChange)
  }
}

function getSnapshot() {
  return document.visibilityState !== "hidden"
}

function getServerSnapshot() {
  return true
}

/** True while the tab / PWA window is in the foreground. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
