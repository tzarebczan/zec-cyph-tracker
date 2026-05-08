"use client"

import { useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"

/**
 * useState that mirrors itself to localStorage so view choices like
 * "which tab is open?" or "is the extended-hours toggle on?" survive
 * a refresh.
 *
 * SSR-safe by design: the initial render uses `initial` so the server
 * and client agree (no hydration mismatch). Right after mount we read
 * localStorage and update state if there's a stored value — that
 * causes a one-frame flash for users who landed on a non-default
 * tab, which is fine for transient UI state but means this hook is
 * NOT suitable for anything visually critical above the fold.
 *
 * Optional `validate` lets the caller reject malformed / outdated
 * stored values (e.g. enum tightened to fewer choices) so the hook
 * silently falls back to `initial` rather than crashing on a stale
 * shape from someone's old session.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(initial)
  // Tracks whether we've finished the initial localStorage read. We
  // skip the write-back effect until then so that the very first
  // post-mount sync (storage → state) doesn't immediately echo back
  // and clobber a value written by a different tab between renders.
  const hydrated = useRef(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw != null) {
        const parsed = JSON.parse(raw) as unknown
        if (!validate || validate(parsed)) {
          setState(parsed as T)
        }
      }
    } catch {
      /* corrupted JSON or storage disabled — keep initial */
    } finally {
      hydrated.current = true
    }
  }, [key, validate])

  useEffect(() => {
    if (!hydrated.current) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* quota / privacy mode — non-fatal */
    }
  }, [key, state])

  return [state, setState]
}
