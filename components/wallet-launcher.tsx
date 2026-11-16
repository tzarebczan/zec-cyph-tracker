"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react"
import { ChevronRight, GripVertical, KeyRound } from "lucide-react"
import {
  onLauncherReset,
  readLauncherPosition,
  resetLauncherPosition,
  saveLauncherPosition,
  type LauncherPosition,
} from "@/lib/wallet-launcher"
import styles from "./wallet-launcher.module.css"

export type LauncherVariant = "mark" | "key" | "pill"

const GAP = 12
const LONG_PRESS_MS = 380
const DEFAULT_POSITION: LauncherPosition = { side: "right", y: 1 }

/** Coffer's mark, geometry copied from the wallet's coffer-signal.svg. The
 *  stroke follows the site palette. */
export function CofferMark({ size }: { size: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="#141B22" />
      <path d="M38 19V9H10v30h28V29M31 19v-3H17v16h14v-3" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
    </svg>
  )
}

type Drag = { id: number; startX: number; startY: number; offsetX: number; offsetY: number; armed: boolean; active: boolean; last?: { left: number; top: number }; timer?: ReturnType<typeof setTimeout> }

export function WalletLauncher({
  variant,
  panelOpen,
  onOpen,
  holdingsSrc,
}: {
  variant: LauncherVariant
  panelOpen: boolean
  onOpen: () => void
  /** A Coffer-hosted balance view. The host only positions this frame and
   *  never receives its contents. Absent until Coffer ships such a view. */
  holdingsSrc?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [position, setPosition] = useState<LauncherPosition>(DEFAULT_POSITION)
  const [moved, setMoved] = useState(false)
  const [top, setTop] = useState<number | null>(null)
  const [dragAt, setDragAt] = useState<{ left: number; top: number } | null>(null)
  const [pressing, setPressing] = useState(false)
  const [card, setCard] = useState(false)
  // Only a fold toggled here animates, not a restore or reopening the page.
  const [animate, setAnimate] = useState(false)
  const folded = !!position.folded

  const bounds = useCallback(() => {
    const el = root.current
    const safe = probe.current ? getComputedStyle(probe.current) : null
    const inset = (side: "Top" | "Bottom") => safe ? parseFloat(safe[`padding${side}`]) || 0 : 0
    const nav = document.querySelector(".cz-bottom-tabs")?.getBoundingClientRect()
    const floor = Math.min(nav && nav.height > 0 ? nav.top : innerHeight, innerHeight - inset("Bottom"))
    const minTop = inset("Top") + GAP
    const maxTop = Math.max(minTop, floor - GAP - (el?.offsetHeight ?? 52))
    return { minTop, maxTop }
  }, [])

  const place = useCallback((next: LauncherPosition) => {
    const { minTop, maxTop } = bounds()
    setTop(Math.round(minTop + next.y * (maxTop - minTop)))
  }, [bounds])

  useEffect(() => {
    const restore = () => {
      const saved = readLauncherPosition()
      setPosition(saved ?? DEFAULT_POSITION)
      setMoved(saved !== null)
    }
    restore()
    return onLauncherReset(restore)
  }, [])

  // Re-measure when the place, the variant's size or the viewport changes.
  useLayoutEffect(() => {
    if (panelOpen) return
    place(position)
    const onResize = () => place(position)
    addEventListener("resize", onResize)
    return () => removeEventListener("resize", onResize)
  }, [place, position, variant, panelOpen])

  // A long press arms dragging on touch. From then on the page must not
  // scroll under the finger, which only a non-passive listener can stop.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const hold = (event: TouchEvent) => { if (drag.current?.armed) event.preventDefault() }
    el.addEventListener("touchmove", hold, { passive: false })
    return () => el.removeEventListener("touchmove", hold)
  }, [])

  useEffect(() => {
    if (!card) return
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setCard(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [card])

  const commit = (next: LauncherPosition) => {
    setPosition(next)
    setMoved(true)
    saveLauncherPosition(next)
    place(next)
  }

  const endDrag = () => {
    const current = drag.current
    drag.current = null
    clearTimeout(current?.timer)
    setPressing(false)
    const at = current?.active ? current.last : undefined
    if (!at || !root.current) { setDragAt(null); return }
    const { minTop, maxTop } = bounds()
    const side = at.left + root.current.offsetWidth / 2 < innerWidth / 2 ? "left" : "right"
    const y = maxTop > minTop ? (Math.min(Math.max(at.top, minTop), maxTop) - minTop) / (maxTop - minTop) : 1
    setDragAt(null)
    commit({ ...position, side, y: Math.round(y * 1000) / 1000 })
  }

  const toggleFold = () => {
    setCard(false)
    setAnimate(true)
    commit(folded ? { side: position.side, y: position.y } : { ...position, folded: true })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !root.current || (event.target as Element).closest(`.${styles.card}`)) return
    suppressClick.current = false
    const rect = root.current.getBoundingClientRect()
    const onGrip = !!(event.target as Element).closest("[data-grip]")
    const next: Drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      armed: event.pointerType !== "touch" || onGrip,
      active: false,
    }
    if (!next.armed) {
      next.timer = setTimeout(() => {
        next.armed = true
        suppressClick.current = true
        setPressing(true)
        navigator.vibrate?.(8)
      }, LONG_PRESS_MS)
    }
    drag.current = next
    // Capture on the pressed button, not the wrapper, so a plain click still
    // lands on that button. Touch pointers are captured implicitly.
    if (next.armed) (event.target as Element).closest("button")?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || event.pointerId !== current.id || !root.current) return
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
    if (!current.armed) {
      // The finger moved before the long press: that is a page scroll.
      if (distance > 8) { clearTimeout(current.timer); drag.current = null }
      return
    }
    if (!current.active) {
      if (distance < 5) return
      current.active = true
      suppressClick.current = true
      setCard(false)
    }
    const width = root.current.offsetWidth
    const height = root.current.offsetHeight
    current.last = {
      left: Math.min(Math.max(event.clientX - current.offsetX, 0), innerWidth - width),
      top: Math.min(Math.max(event.clientY - current.offsetY, 0), innerHeight - height),
    }
    setDragAt(current.last)
  }

  const onClickCapture = (event: MouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.25 : 0.05
    const moves: Record<string, () => LauncherPosition> = {
      ArrowUp: () => ({ ...position, y: Math.max(0, position.y - step) }),
      ArrowDown: () => ({ ...position, y: Math.min(1, position.y + step) }),
      ArrowLeft: () => ({ ...position, side: "left" }),
      ArrowRight: () => ({ ...position, side: "right" }),
    }
    if (moves[event.key]) { event.preventDefault(); commit(moves[event.key]()) }
    if (event.key === "Escape") setCard(false)
  }

  const side = position.side
  const style = dragAt
    ? { left: dragAt.left, top: dragAt.top, right: "auto", bottom: "auto" }
    : top === null ? undefined : { top, bottom: "auto" }
  const below = (dragAt?.top ?? top ?? Infinity) < (typeof window === "undefined" ? 0 : innerHeight / 2)
  const label = "Open CYPH wallet by Coffer"

  return (
    <div
      ref={root}
      className={styles.root}
      data-variant={variant}
      data-side={side}
      data-folded={folded || undefined}
      data-animate={animate || undefined}
      data-state={dragAt ? "dragging" : pressing ? "pressing" : "idle"}
      hidden={panelOpen}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
      onContextMenu={event => { if (drag.current) event.preventDefault() }}
    >
      <span ref={probe} className={styles.safeProbe} aria-hidden="true" />
      <button
        type="button"
        className={styles.fold}
        aria-label={folded ? "Show wallet button" : "Fold wallet button"}
        aria-expanded={!folded}
        title={folded ? "Show wallet button" : "Fold to icon"}
        onClick={toggleFold}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      {!folded && <button
        data-grip
        type="button"
        className={styles.grip}
        aria-label="Wallet launcher options. Drag or use arrow keys to move"
        aria-expanded={card}
        aria-controls="coffer-launcher-card"
        onClick={() => setCard(value => !value)}
        onKeyDown={onGripKey}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>}
      <button
        type="button"
        className={styles.main}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        aria-controls="coffer-cyph-wallet"
        aria-label={variant === "mark" || folded ? label : undefined}
        title={label}
        onClick={onOpen}
        onAnimationEnd={() => setAnimate(false)}
      >
        {folded && <CofferMark size={34} />}
        {!folded && variant === "mark" && <CofferMark size={32} />}
        {!folded && variant === "key" && <>
          <CofferMark size={30} />
          <span className={styles.words}>
            <strong><KeyRound size={13} aria-hidden="true" />Wallet</strong>
            <small>by Coffer</small>
          </span>
        </>}
        {!folded && variant === "pill" && <>
          <CofferMark size={24} />
          <span className={styles.words}><strong>Coffer <span aria-hidden="true">·</span> CYPH</strong></span>
        </>}
      </button>
      {card && (
        <section id="coffer-launcher-card" className={styles.card} data-below={below || undefined} aria-label="CYPH wallet" onKeyDown={event => { if (event.key === "Escape") setCard(false) }}>
          <div className={styles.cardHead}>
            <CofferMark size={28} />
            <div><strong>CYPH wallet</strong><small>by Coffer</small></div>
          </div>
          {holdingsSrc
            ? <iframe className={styles.holdings} src={holdingsSrc} title="Your balances in Coffer" sandbox="allow-scripts allow-same-origin" />
            : <p>Trade, send and receive CYPH and ZEC. Balances stay inside Coffer; this site cannot see them.</p>}
          <button type="button" className={styles.open} onClick={() => { setCard(false); onOpen() }}>Open wallet</button>
          <div className={styles.cardLinks}>
            {moved && <button type="button" onClick={resetLauncherPosition}>Reset position</button>}
            <a href="/settings">Launcher settings</a>
          </div>
        </section>
      )}
    </div>
  )
}
