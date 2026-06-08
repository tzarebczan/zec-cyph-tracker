"use client"

import { useSyncExternalStore } from "react"

function subscribe(onStoreChange: () => void) {
  document.addEventListener("visibilitychange", onStoreChange)
  return () => document.removeEventListener("visibilitychange", onStoreChange)
}

function getSnapshot() {
  return document.visibilityState === "visible"
}

function getServerSnapshot() {
  return true
}

/** True while the tab / PWA window is in the foreground. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
