"use client"

import { useEffect, useRef, useState } from "react"

// Returns "up" / "down" / null based on whether `value` rose, fell, or
// stayed the same since the previous render. Auto-clears after the
// animation duration so a CSS class bound to the result plays exactly
// once per change. Null/NaN and "same as last time" passes are ignored
// — that's important because SWR's keepPreviousData semantics emit a
// fresh render with an identical number on every refresh that the
// upstream didn't move, and we don't want a phantom flash on those.
export function useFlashOnChange(
  value: number | null | undefined
): "up" | "down" | null {
  const prev = useRef<number | null>(null)
  const [flash, setFlash] = useState<"up" | "down" | null>(null)
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return
    const previous = prev.current
    prev.current = value
    if (previous == null || previous === value) return
    setFlash(value > previous ? "up" : "down")
    const t = setTimeout(() => setFlash(null), 700)
    return () => clearTimeout(t)
  }, [value])
  return flash
}
