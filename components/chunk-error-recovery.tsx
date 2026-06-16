"use client"

import { useEffect } from "react"

/**
 * Detect and recover from stale Next.js chunks / webpack runtime errors
 * after a deployment. Covers:
 *   - ChunkLoadError / "Loading chunk N failed"
 *   - "Failed to fetch dynamically imported module"
 *   - Webpack runtime "l[e] is not a function" / "Cannot read properties of
 *     undefined (reading 'call')" caused by a missing module in a stale chunk
 *
 * We log diagnostics and reload once. A small session-storage guard prevents
 * infinite reload loops if the error is not deployment-related.
 */
export function ChunkErrorRecovery() {
  useEffect(() => {
    const isChunkError = (err: ErrorEvent | PromiseRejectionEvent): boolean => {
      const msg =
        err instanceof ErrorEvent ? err.message : String(err.reason ?? "")
      const stack =
        err instanceof ErrorEvent && err.error?.stack
          ? String(err.error.stack)
          : ""
      const combined = `${msg} ${stack}`
      return /Loading chunk \d+ failed|ChunkLoadError|Loading CSS chunk|Failed to fetch dynamically imported module|is not a function|Cannot read properties of undefined|webpack/i.test(
        combined
      )
    }

    const extractDetail = (
      err: ErrorEvent | PromiseRejectionEvent
    ): Record<string, unknown> => {
      if (err instanceof ErrorEvent) {
        return {
          message: err.message,
          filename: err.filename,
          lineno: err.lineno,
          colno: err.colno,
          stack: err.error?.stack,
        }
      }
      const reason = err.reason
      return {
        message: String(reason ?? ""),
        stack: reason instanceof Error ? reason.stack : undefined,
      }
    }

    let reloading = false
    const handleError = (event: ErrorEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      reloading = true
      const detail = extractDetail(event)
      console.warn("[chunk-recovery] Stale chunk / webpack runtime error:", detail)
      // Avoid infinite reload loops: only auto-reload once per session.
      if (sessionStorage.getItem("chunk-recovery-reloaded") === "1") {
        console.warn("[chunk-recovery] Already reloaded this session; not reloading again.")
        return
      }
      sessionStorage.setItem("chunk-recovery-reloaded", "1")
      window.location.reload()
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      reloading = true
      const detail = extractDetail(event)
      console.warn("[chunk-recovery] Stale dynamic import rejected:", detail)
      if (sessionStorage.getItem("chunk-recovery-reloaded") === "1") {
        console.warn("[chunk-recovery] Already reloaded this session; not reloading again.")
        return
      }
      sessionStorage.setItem("chunk-recovery-reloaded", "1")
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
