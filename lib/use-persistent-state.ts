"use client"

import { useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"

/**
 * useState that mirrors itself to localStorage so view choices like
 * "which tab is open?" or "is the extended-hours toggle on?" survive
 * a refresh.
 *
 * SSR-safe by design: the initial render uses `initial` so the server
 * and client agree (no hydration mismatch). After mount the hook reads
 * localStorage exactly once and seeds state from it. That causes a
 * one-frame flash for users who landed on a non-default value, which
 * is fine for transient UI state but means this hook is NOT suitable
 * for anything visually critical above the fold.
 *
 * Optional `validate` lets the caller reject malformed / outdated
 * stored values (e.g. enum tightened to fewer choices) so the hook
 * silently falls back to `initial` rather than crashing on a stale
 * shape from someone's old session. We stash the validator in a ref
 * so callers can pass an inline arrow without retriggering the read
 * effect on every render — without that, a fresh function reference
 * each render would race with the write effect and oscillate state
 * between current value and stored value.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(initial)
  // hydrated must be a state — not a ref — so flipping it triggers the
  // write effect on the *next* render. Putting it in a ref would let the
  // write effect run in the same commit as the read effect and clobber
  // the stored value with `initial` immediately on mount.
  const [hydrated, setHydrated] = useState(false)
  const validateRef = useRef(validate)
  validateRef.current = validate

  useEffect(() => {
    let nextState: T | null = null
    try {
      const raw = window.localStorage.getItem(key)
      if (raw != null) {
        const parsed = JSON.parse(raw) as unknown
        const v = validateRef.current
        if (!v || v(parsed)) {
          nextState = parsed as T
        }
      }
    } catch {
      /* corrupted JSON or storage disabled — keep initial */
    }
    if (nextState !== null) setState(nextState)
    setHydrated(true)
  }, [key])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* quota / privacy mode — non-fatal */
    }
  }, [hydrated, key, state])

  return [state, setState]
}
