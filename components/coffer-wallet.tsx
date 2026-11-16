"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowUpRight, HelpCircle, Maximize2, Minimize2, PanelTop, X } from "lucide-react"
import { connectCofferFrame, type CofferView } from "@/lib/coffer-embed"
import { E_PALETTES } from "./palettes"
import { useCyphzecSettings } from "./use-cyphzec-settings"
import { WalletLauncher } from "./wallet-launcher"
import { markWalletOpened } from "@/lib/wallet-launcher"
import styles from "./coffer-wallet.module.css"

const FULL_WALLET_URL = "https://cofferwallet.com/"

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
  const [settings] = useCyphzecSettings()
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

  const show = () => {
    setLoaded(true)
    setOpen(true)
    markWalletOpened()
    dialog.current?.showModal()
    // The iframe would otherwise be the first focusable element, and focus
    // inside a cross-origin frame would swallow Esc.
    closeButton.current?.focus()
  }

  if (!settings.cofferWallet) return null

  return (
    <>
      <WalletLauncher variant={settings.cofferLauncher} panelOpen={open} onOpen={show} />
      <dialog
        id="coffer-cyph-wallet"
        ref={dialog}
        className={styles.panel}
        data-view={view}
        aria-labelledby="coffer-wallet-title"
        onClose={() => { setOpen(false); setHelp(false) }}
      >
        <h2 id="coffer-wallet-title" className={styles.srOnly}>CYPH / ZEC</h2>
        {state === "loading" && <p className={styles.status} role="status">Opening your wallet…</p>}
        {state === "error" && <p className={styles.status} role="status">Wallet unavailable here. <a href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer">Continue in Coffer</a>.</p>}
        {loaded && <iframe
          ref={frame}
          src={walletUrl().href}
          title="CYPH wallet by Coffer"
          className={styles.frame}
          allow={`publickey-credentials-get ${origin}; publickey-credentials-create ${origin}; camera ${origin}; clipboard-read ${origin}; clipboard-write ${origin}; cross-origin-isolated`}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        />}
        {help && <section id="coffer-wallet-help" className={styles.helpContent} aria-label="Wallet help">
          <p>Your keys, recovery phrase and balances stay in Coffer. This site cannot see them.</p>
          <p>Solana activity, including CYPH, is public.</p>
          <p>Passkey, camera or paste blocked? <a href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer">Open full Coffer</a>. It may ask you to sign in again.</p>
          <a className={styles.helpLink} href="/settings" onClick={() => dialog.current?.close()}>Hide the launcher in Settings</a>
        </section>}
        <footer className={styles.footer}>
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
