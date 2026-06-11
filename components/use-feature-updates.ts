"use client"

import { useCallback, useEffect, useState } from "react"
import { LATEST_UPDATE_ID, UPDATE_SEEN_KEY } from "./updates-data"

function readSeenUpdateId(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(UPDATE_SEEN_KEY)
  } catch {
    return null
  }
}

function writeSeenUpdateId(id: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(UPDATE_SEEN_KEY, id)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: UPDATE_SEEN_KEY,
        newValue: id,
      })
    )
  } catch {
    /* localStorage can be disabled; hints simply remain session-only. */
  }
}

export function useFeatureUpdates() {
  const [seenId, setSeenId] = useState<string | null>(null)

  useEffect(() => {
    setSeenId(readSeenUpdateId())
    const onStorage = (event: StorageEvent) => {
      if (event.key === UPDATE_SEEN_KEY) setSeenId(event.newValue)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const markLatestSeen = useCallback(() => {
    if (!LATEST_UPDATE_ID) return
    setSeenId(LATEST_UPDATE_ID)
    writeSeenUpdateId(LATEST_UPDATE_ID)
  }, [])

  return {
    latestUpdateId: LATEST_UPDATE_ID,
    hasUnseenUpdates: Boolean(LATEST_UPDATE_ID && seenId !== LATEST_UPDATE_ID),
    markLatestSeen,
  }
}
