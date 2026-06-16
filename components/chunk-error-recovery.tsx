"use client"

import { useEffect } from "react"
import {
  cleanClientReload,
  removeReloadParam,
} from "@/lib/clean-client-reload"

const RECOVERY_KEY = "chunk-recovery-state-v2"
const RECOVERY_PARAM = "__chunk_recover"
const RECOVERY_WINDOW_MS = 2 * 60 * 1000
const MAX_RECOVERY_ATTEMPTS = 2

/**
 * Detect and recover from stale Next.js chunks / webpack runtime errors
 * after a deployment. Covers:
 *   - ChunkLoadError / "Loading chunk N failed"
 *   - "Failed to fetch dynamically imported module"
 *   - Webpack runtime "l[e] is not a function" / "Cannot read properties of
 *     undefined (reading 'call')" caused by a missing module in a stale chunk
 *
 * We log diagnostics, clear the app SW/cache layer, and reload with a temporary
 * cache-busting query param. A rolling session guard prevents infinite reload
 * loops if the error is not deployment-related.
 */
export function ChunkErrorRecovery() {
  useEffect(() => {
    const currentBuildVersion = () => {
      return (
        window.__APP_VERSION__ ??
        document
          .querySelector('meta[name="app-version"]')
          ?.getAttribute("content") ??
        "unknown"
      )
    }

    const isChunkError = (err: ErrorEvent | PromiseRejectionEvent): boolean => {
      const msg =
        err instanceof ErrorEvent ? err.message : String(err.reason ?? "")
      const filename = err instanceof ErrorEvent ? err.filename : ""
      const stack =
        err instanceof ErrorEvent && err.error?.stack
          ? String(err.error.stack)
          : err instanceof PromiseRejectionEvent &&
              err.reason instanceof Error &&
              err.reason.stack
            ? String(err.reason.stack)
            : ""
      const combined = `${msg} ${filename} ${stack}`
      const explicitChunkFailure =
        /Loading chunk \d+ failed|ChunkLoadError|Loading CSS chunk|Failed to fetch dynamically imported module/i.test(
          combined
        )
      const nextRuntimeChunk =
        /\/_next\/static\/chunks\/|\\_next\\static\\chunks\\|webpack-[a-f0-9]+\.js/i.test(
          combined
        )
      const webpackRuntimeFailure =
        /l\[[^\]]+\] is not a function|Cannot read properties of undefined|is not a function/i.test(
          msg
        )
      return explicitChunkFailure || (nextRuntimeChunk && webpackRuntimeFailure)
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

    const readRecoveryState = (): {
      version: string
      firstAt: number
      attempts: number
    } | null => {
      try {
        const raw = sessionStorage.getItem(RECOVERY_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as {
          version?: unknown
          firstAt?: unknown
          attempts?: unknown
        }
        if (
          typeof parsed.version === "string" &&
          typeof parsed.firstAt === "number" &&
          typeof parsed.attempts === "number"
        ) {
          return {
            version: parsed.version,
            firstAt: parsed.firstAt,
            attempts: parsed.attempts,
          }
        }
      } catch {
        return null
      }
      return null
    }

    const markRecoveryAttempt = () => {
      const version = currentBuildVersion()
      const now = Date.now()
      const previous = readRecoveryState()
      const withinWindow =
        previous != null &&
        previous.version === version &&
        now - previous.firstAt < RECOVERY_WINDOW_MS
      const next = {
        version,
        firstAt: withinWindow ? previous.firstAt : now,
        attempts: withinWindow ? previous.attempts + 1 : 1,
      }
      try {
        sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(next))
      } catch {}
      return next
    }

    const canAttemptRecovery = () => {
      const previous = readRecoveryState()
      if (!previous) return true
      if (previous.version !== currentBuildVersion()) return true
      if (Date.now() - previous.firstAt >= RECOVERY_WINDOW_MS) return true
      return previous.attempts < MAX_RECOVERY_ATTEMPTS
    }

    const reloadOnce = (label: string, detail: Record<string, unknown>) => {
      console.warn(label, detail)
      if (!canAttemptRecovery()) {
        console.warn(
          "[chunk-recovery] Recovery attempts exhausted for this build; not reloading again."
        )
        return false
      }
      const attempt = markRecoveryAttempt()
      console.warn("[chunk-recovery] Clearing app caches and reloading:", attempt)
      void cleanClientReload(RECOVERY_PARAM)
      return true
    }

    removeReloadParam(RECOVERY_PARAM)

    let reloading = false
    const handleError = (event: ErrorEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      const detail = extractDetail(event)
      reloading = reloadOnce(
        "[chunk-recovery] Stale chunk / webpack runtime error:",
        detail
      )
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      if (reloading) return
      if (!isChunkError(event)) return
      const detail = extractDetail(event)
      reloading = reloadOnce(
        "[chunk-recovery] Stale dynamic import rejected:",
        detail
      )
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
