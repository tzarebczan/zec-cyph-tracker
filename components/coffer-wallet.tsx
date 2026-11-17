"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react"
import { ArrowUpRight, HelpCircle, Maximize2, Minimize2, PanelTop, X } from "lucide-react"
import { connectCofferFrame, type CofferView } from "@/lib/coffer-embed"
import { E_PALETTES } from "./palettes"
import { useCyphzecSettings } from "./use-cyphzec-settings"
import { WalletLauncher } from "./wallet-launcher"
import { markWalletOpened } from "@/lib/wallet-launcher"
import styles from "./coffer-wallet.module.css"

const FULL_WALLET_URL = "https://cofferwallet.com/"
/** Space kept between the panel and the screen edges. */
const EDGE = 8

type Place = { left: number; top: number }

/** Keeps a panel of the given size fully on screen. */
function clampPlace(place: Place, width: number, height: number): Place {
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, EDGE), Math.max(EDGE, max)))
  return { left: clamp(place.left, innerWidth - width - EDGE), top: clamp(place.top, innerHeight - height - EDGE) }
}

/** Beside the launcher: the panel shares its nearer horizontal edge, and opens
 *  downward from a launcher in the top half or upward from one in the bottom half. */
function placeBeside(anchor: DOMRect, width: number, height: number): Place {
  const right = anchor.left + anchor.width / 2 > innerWidth / 2
  const lower = anchor.top + anchor.height / 2 > innerHeight / 2
  return clampPlace({
    left: right ? anchor.right - width : anchor.left,
    top: lower ? anchor.bottom - height : anchor.top,
  }, width, height)
}

function walletUrl() {
  const configured = process.env.NODE_ENV === "development"
    ? process.env.NEXT_PUBLIC_COFFER_WALLET_URL
    : undefined
  const url = new URL(configured || FULL_WALLET_URL)
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.origin !== new URL(FULL_WALLET_URL).origin && !local) {
    throw new Error("Use Coffer's official wallet or a local development server.")
  }
  url.searchParams.set("embed", "1")
  return url
}

export function CofferWallet() {
  const dialog = useRef<HTMLDialogElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const connection = useRef<ReturnType<typeof connectCofferFrame> | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<CofferView>("compact")
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [help, setHelp] = useState(false)
  const anchor = useRef<DOMRect | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [settings] = useCyphzecSettings()
  // The server cannot know the saved launcher style or place, so the launcher
  // appears only once the browser has read them: no expanded-then-folded jump.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const accent = E_PALETTES[settings.palette].cyph
  const origin = walletUrl().origin

  useEffect(() => {
    if (!loaded || !frame.current) return
    const client = connectCofferFrame({ iframe: frame.current, url: walletUrl(), onState: setState })
    connection.current = client
    return () => {
      client.destroy()
      connection.current = null
    }
  }, [loaded])

  useEffect(() => {
    connection.current?.update(view, accent)
  }, [view, accent, loaded])

  useEffect(() => {
    if (settings.cofferWallet) return
    dialog.current?.close()
    setOpen(false)
    setLoaded(false)
  }, [settings.cofferWallet])

  // Opening beside the launcher needs the panel's size, which CSS sets per view.
  // A view change or resize keeps the panel where it is, pulled back on screen.
  const fit = useCallback((from: "anchor" | "current") => {
    const panel = dialog.current
    if (!panel?.open) return
    const { width, height } = panel.getBoundingClientRect()
    setPlace(current => from === "anchor" && anchor.current
      ? placeBeside(anchor.current, width, height)
      : current ? clampPlace(current, width, height) : null)
  }, [])

  useLayoutEffect(() => { if (open) fit("current") }, [view, open, fit])

  useEffect(() => {
    if (!open) return
    const onResize = () => fit("current")
    addEventListener("resize", onResize)
    return () => removeEventListener("resize", onResize)
  }, [open, fit])

  // The top strip and the footer's empty space move the panel. Buttons and links keep their clicks.
  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !dialog.current || (event.target as Element).closest("button, a")) return
    const rect = dialog.current.getBoundingClientRect()
    drag.current = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    event.preventDefault()
  }
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId || !dialog.current) return
    const { width, height } = dialog.current.getBoundingClientRect()
    setPlace(clampPlace({ left: event.clientX - current.dx, top: event.clientY - current.dy }, width, height))
  }
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }
  const dragHandle = { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag }

  const show = (from: DOMRect) => {
    anchor.current = from
    setLoaded(true)
    setOpen(true)
    markWalletOpened()
    dialog.current?.showModal()
    fit("anchor")
    // The iframe would otherwise be the first focusable element, and focus
    // inside a cross-origin frame would swallow Esc.
    closeButton.current?.focus()
  }

  if (!settings.cofferWallet) return null

  return (
    <>
      {mounted && <WalletLauncher variant={settings.cofferLauncher} panelOpen={open} onOpen={show} />}
      <dialog
        id="coffer-cyph-wallet"
        ref={dialog}
        className={styles.panel}
        data-view={view}
        data-dragging={dragging || undefined}
        style={place ? { left: place.left, top: place.top, right: "auto", bottom: "auto" } : undefined}
        aria-labelledby="coffer-wallet-title"
        onClose={() => { setOpen(false); setHelp(false) }}
      >
        <h2 id="coffer-wallet-title" className={styles.srOnly}>CYPH / ZEC</h2>
        <div className={styles.grip} title="Drag to move" aria-hidden="true" {...dragHandle}><span /></div>
        {state === "loading" && <p className={styles.status} role="status">Opening your wallet…</p>}
        {state === "error" && <p className={styles.status} role="status">Wallet unavailable here. <a href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer">Continue in Coffer</a>.</p>}
        {loaded && <iframe
          ref={frame}
          src={walletUrl().href}
          title="CYPH wallet by Coffer"
          className={styles.frame}
          // storage-access and its sandbox token let Coffer open its own storage (Chrome) instead of a copy.
          allow={`publickey-credentials-get ${origin}; publickey-credentials-create ${origin}; camera ${origin}; clipboard-read ${origin}; clipboard-write ${origin}; cross-origin-isolated; storage-access ${origin}`}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-storage-access-by-user-activation"
        />}
        {help && <section id="coffer-wallet-help" className={styles.helpContent} aria-label="Wallet help">
          <p>Your keys, recovery phrase and balances stay in Coffer. This site cannot see them.</p>
          <p>Solana activity, including CYPH, is public.</p>
          <p>Passkey, camera or paste blocked? <a href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer">Open full Coffer</a>. It may ask you to sign in again.</p>
          <a className={styles.helpLink} href="/settings" onClick={() => dialog.current?.close()}>Hide the launcher in Settings</a>
        </section>}
        <footer className={styles.footer} {...dragHandle}>
          <a className={styles.fullLink} href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer"><span>Full Coffer</span><ArrowUpRight size={12} aria-hidden="true" /></a>
          <div className={styles.views} role="group" aria-label="Wallet layout">
            {([
              ["compact", "Compact", Minimize2],
              ["simple", "Simple", PanelTop],
              ["full", "Full", Maximize2],
            ] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-label={`${label} view`} aria-pressed={view === value} onClick={() => setView(value)}>
              <Icon size={14} aria-hidden="true" />
            </button>)}
          </div>
          <button className={styles.helpToggle} type="button" aria-label="Wallet help" aria-expanded={help} aria-controls={help ? "coffer-wallet-help" : undefined} onClick={() => setHelp(value => !value)}><HelpCircle size={15} aria-hidden="true" /></button>
          <button ref={closeButton} className={styles.close} type="button" aria-label="Close wallet" onClick={() => dialog.current?.close()}><X size={16} aria-hidden="true" /></button>
        </footer>
      </dialog>
    </>
  )
}
