"use client"

import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import { paletteVar } from "./theme"

// ──────────────────────────────────────────────────────────────────────
// Reusable share button — Copy Link + Share to X dropdown.
//
// Platform split:
//   - iOS/Android: try Web Share with the rendered OG PNG attached first.
//     The file is explicitly named .png and typed image/png.
//     If the browser rejects the payload before handoff, fall back to
//     X intent + OG card.
//   - Desktop/fallback: use X intent + OG card.
//
// Used on /what-if (with /api/og/what-if) and /stats (with
// /api/og/stats) — same component, different OG image source.
// ──────────────────────────────────────────────────────────────────────

interface ShareIconProps {
  size?: number
}
function ShareIcon({ size = 14 }: ShareIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="8" r="1.6" />
      <circle cx="12" cy="3.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M5.4 7.2 10.6 4.3M5.4 8.8 10.6 11.7" />
    </svg>
  )
}

type FileShareOutcome = "shared" | "cancelled" | "unsupported"

function appendQueryParam(path: string, key: string, value: string): string {
  const join = path.includes("?") ? "&" : "?"
  return `${path}${join}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

function xPostText(text: string, url: string): string {
  const body = text.trim()
  const needsZcashNative =
    /\$ZEC\b/i.test(body) && !/\bzcash:native\b/i.test(body)
  return [body, url, needsZcashNative ? "Zcash chart: zcash:native" : null]
    .filter(Boolean)
    .join("\n\n")
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
}

function pngName(name: string): string {
  return name.toLowerCase().endsWith(".png") ? name : `${name}.png`
}

function xIntentHref(postText: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(postText)}`
}

/** Fetch the OG snapshot for the current page and try to share it as
 *  an attached PNG via the Web Share API. Returns "unsupported" when
 *  the browser doesn't expose file-aware share, so the caller can
 *  fall through to the classic Twitter intent URL. */
async function tryShareWithFile(
  text: string,
  ogImagePath: string,
  pngFileName: string
): Promise<FileShareOutcome> {
  if (typeof navigator === "undefined") return "unsupported"
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (typeof nav.canShare !== "function" || typeof nav.share !== "function") {
    return "unsupported"
  }
  try {
    // Bust at minute precision: each share within a minute reuses
    // the CF edge cache; a click next minute triggers a fresh
    // server-side render. Cheap and feels real.
    const bust = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-T:]/g, "")
    const ogResp = await fetch(appendQueryParam(ogImagePath, "bust", bust))
    if (!ogResp.ok) return "unsupported"
    const pngBlob = new Blob([await ogResp.arrayBuffer()], {
      type: "image/png",
    })
    const file = new File([pngBlob], pngName(pngFileName), {
      type: "image/png",
    })
    const data: ShareData = { files: [file], text }
    if (!nav.canShare(data)) return "unsupported"
    await nav.share(data)
    return "shared"
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "cancelled"
    return "unsupported"
  }
}

export interface ShareButtonProps {
  /** Prefilled tweet body — encoded into the Twitter intent URL when
   *  the desktop fallback path triggers, and passed to navigator.share
   *  on mobile so the user sees it as the default tweet text. */
  tweetText: string
  /** Path to the OG image route, e.g. "/api/og/what-if". The component
   *  appends a minute-precision `?bust=` query so a click in a fresh
   *  minute fetches a freshly-rendered PNG. */
  ogImagePath: string
  /** Filename for the attached PNG. Visible in the share sheet on
   *  some platforms (Files app on iOS, for instance). */
  pngFileName: string
  /** Optional explicit canonical URL — defaults to window.location
   *  with query/hash stripped so the shared link stays clean. */
  shareUrl?: string
  xCacheBust?: boolean
  /** Aria label override (defaults to "Share this page"). */
  ariaLabel?: string
}

export function ShareButton({
  tweetText,
  ogImagePath,
  pngFileName,
  shareUrl,
  xCacheBust = false,
  ariaLabel = "Share this page",
}: ShareButtonProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [twitterIntentHref, setTwitterIntentHref] = useState(
    "https://x.com/intent/tweet"
  )
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Outside-click + Escape close, standard menu UX.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const pageUrl = (): string => {
    if (shareUrl) return shareUrl
    if (typeof window === "undefined") return "https://cyphzec.com"
    const u = new URL(window.location.href)
    u.search = ""
    u.hash = ""
    return u.toString()
  }

  const xPageUrl = (): string => {
    const url = pageUrl()
    if (!xCacheBust) return url
    const stamp = new Date()
      .toISOString()
      .slice(0, 13)
      .replace(/[-T]/g, "")
    try {
      const u = new URL(url)
      u.searchParams.set("xog", stamp)
      return u.toString()
    } catch {
      return appendQueryParam(url, "xog", stamp)
    }
  }

  const buildTwitterShare = () => {
    const postText = xPostText(tweetText, xPageUrl())
    return {
      href: xIntentHref(postText),
      postText,
    }
  }

  useEffect(() => {
    setTwitterIntentHref(buildTwitterShare().href)
    // `buildTwitterShare` intentionally stays local to preserve click-time URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareUrl, tweetText, xCacheBust])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl())
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        setOpen(false)
      }, 1200)
    } catch {
      // Clipboard write can throw in non-secure contexts. Fail quiet.
    }
  }

  const handleTwitter = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (sharing) {
      event.preventDefault()
      return
    }

    const { href, postText } = buildTwitterShare()
    event.currentTarget.href = href
    setTwitterIntentHref(href)
    const shouldTryFileShare = isAndroid() || isIOS()
    if (!shouldTryFileShare) {
      setOpen(false)
      return
    }

    event.preventDefault()
    setSharing(true)
    let outcome: FileShareOutcome = "unsupported"
    try {
      outcome = await tryShareWithFile(postText, ogImagePath, pngFileName)
    } finally {
      setSharing(false)
    }

    if (outcome === "shared" || outcome === "cancelled") {
      setOpen(false)
      return
    }

    window.location.assign(href)
    setOpen(false)
  }

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center justify-center p-2 transition-colors hover:bg-emerald-950/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
        style={{
          color: paletteVar("cyph"),
          border: `1px solid ${paletteVar("text")}33`,
          outlineColor: paletteVar("cyph"),
        }}
      >
        <ShareIcon />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[10rem] z-30 flex flex-col text-[11px] tracking-[0.15em]"
          style={{
            background: "#000",
            border: `1px solid ${paletteVar("text")}55`,
            color: paletteVar("text"),
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="text-left px-3 py-2 transition-colors hover:bg-emerald-950/40"
            style={{ color: paletteVar("cyph") }}
          >
            {copied ? "✓ LINK COPIED" : "COPY LINK"}
          </button>
          <a
            role="menuitem"
            href={twitterIntentHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleTwitter}
            aria-disabled={sharing}
            className={`text-left px-3 py-2 transition-colors hover:bg-emerald-950/40 border-t ${
              sharing ? "opacity-60" : ""
            }`}
            style={{
              color: paletteVar("cyph"),
              borderColor: paletteVar("text") + "33",
            }}
          >
            {sharing ? "PREPARING IMAGE…" : "SHARE TO X →"}
          </a>
        </div>
      )}
    </div>
  )
}
