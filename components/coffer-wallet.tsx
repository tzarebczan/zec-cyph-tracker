"use client"

import { useEffect, useRef, useState } from "react"
import { connectCofferFrame, type CofferView } from "@/lib/coffer-embed"
import { E_PALETTES } from "./palettes"
import { useCyphzecSettings } from "./use-cyphzec-settings"
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
  const connection = useRef<ReturnType<typeof connectCofferFrame> | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<CofferView>("compact")
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
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
    dialog.current?.showModal()
  }

  if (!settings.cofferWallet) return null

  return (
    <>
      <button
        type="button"
        className={styles.launcher}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="coffer-cyph-wallet"
        onClick={show}
      >
        <span className={styles.launcherIcon} aria-hidden="true">↗</span><span><strong>CYPH wallet</strong><small>Trade · Send · Receive</small></span>
      </button>
      <dialog
        id="coffer-cyph-wallet"
        ref={dialog}
        className={styles.panel}
        data-view={view}
        aria-labelledby="coffer-wallet-title"
        onClose={() => setOpen(false)}
      >
        <header className={styles.header}>
          <div>
            <h2 id="coffer-wallet-title">Your CYPH wallet</h2>
            <span>Your wallet, powered by Coffer</span>
          </div>
          <button type="button" aria-label="Close wallet" onClick={() => dialog.current?.close()}>×</button>
        </header>
        <div className={styles.options}>
          <label htmlFor="coffer-wallet-view">View</label>
          <select id="coffer-wallet-view" value={view} onChange={(event) => {
            const value = event.target.value
            if (value === "compact" || value === "simple" || value === "full") setView(value)
          }}>
            <option value="compact">Compact</option>
            <option value="simple">Simple</option>
            <option value="full">Full</option>
          </select>
          <a href={FULL_WALLET_URL} target="_blank" rel="noopener noreferrer">Open full Coffer ↗</a>
        </div>
        <p className={styles.note}>Buy tokenized CYPH, send or receive crypto. Sign in and confirm inside Coffer.</p>
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
        <footer className={styles.footer}>
          <span>Solana activity is public.</span>
          <details><summary>Wallet help</summary><p>This site cannot read your recovery phrase or wallet balances. A new tab may need a separate sign-in because browsers can isolate embedded storage. If your browser blocks a passkey, camera or clipboard, use manual input or open full Coffer.</p><a href="/settings" onClick={() => dialog.current?.close()}>Hide the launcher in site settings</a></details>
        </footer>
      </dialog>
    </>
  )
}
