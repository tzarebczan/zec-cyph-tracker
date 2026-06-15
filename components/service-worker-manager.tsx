"use client"

import { useEffect } from "react"

const UPDATE_CHECK_INTERVAL_MS = 60_000

export function ServiceWorkerManager() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    let registration: ServiceWorkerRegistration | null = null
    let lastUpdateCheck = 0

    const checkForUpdate = async () => {
      if (!registration) return
      const now = Date.now()
      if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return
      lastUpdateCheck = now
      try {
        await registration.update()
      } catch (error) {
        console.warn("[pwa] SW update check failed:", error)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkForUpdate()
    }

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        await checkForUpdate()
        document.addEventListener("visibilitychange", onVisibilityChange)
      } catch (error) {
        console.warn("[pwa] SW registration failed:", error)
      }
    }

    if (document.readyState === "complete") void register()
    else window.addEventListener("load", register, { once: true })

    return () => {
      window.removeEventListener("load", register)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [])

  return null
}
