"use client"

import { useEffect } from "react"

/**
 * Recover from stale Next.js chunks after a deployment. When the user has
 * an old page open and navigates to a route whose chunk was replaced by a
 * new build, Next throws a ChunkLoadError. We catch that and reload the
 * page so the latest assets are fetched. Also handles dynamic-import
 * rejections that surface the same underlying failure.
 */
export function ChunkErrorRecovery() {
  useEffect(() => {
    const isChunkError = (err: ErrorEvent | PromiseRejectionEvent): boolean => {
      const msg =
        err instanceof ErrorEvent ? err.message : String(err.reason ?? "")
      return /Loading chunk \d+ failed|ChunkLoadError|Loading CSS chunk|Failed to fetch dynamically imported module/i.test(
        msg
      )
    }

    let reloading = false
    const handleError = (event: ErrorEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      reloading = true
      console.warn("[chunk-recovery] Stale chunk detected; reloading page.")
      // Bust the cache on reload so we don't land on the same stale shell.
      window.location.reload()
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      reloading = true
      console.warn("[chunk-recovery] Stale dynamic import detected; reloading page.")
      window.location.reload()
    }

    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleRejection)
    return () => {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleRejection)
    }
  }, [])

  return null
}
