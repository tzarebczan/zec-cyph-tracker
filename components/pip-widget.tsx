"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import useSWR from "swr"
import {
  PictureInPicture2,
  X,
  Sun,
  Moon,
  Clock,
} from "lucide-react"
import { usePersistentState } from "@/lib/use-persistent-state"

// Picture-in-Picture widget for CYPH / ZEC at-a-glance stats. Two
// rendering paths so we get coverage on essentially every modern
// browser:
//
//   1. Document Picture-in-Picture (Chrome 116+ desktop, Chrome
//      Android 126+). Real DOM + React + the same Tailwind classes
//      we use everywhere else.
//      https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API
//
//   2. Video Picture-in-Picture (Chrome 70+ everywhere, Chrome
//      Android 67+, Safari iOS 14+, Edge 18+). We render the widget
//      onto a hidden <canvas>, capture it as a video stream via
//      canvas.captureStream(), pipe the stream into a hidden <video>,
//      and call video.requestPictureInPicture(). The OS renders the
//      video stream as a real always-on-top floating window, which
//      means we get widget coverage on Android and iOS (including
//      installed PWAs) where Document PiP is still flaky.
//      https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API
//
// The footer toggle and the top CTA banner are unaware of which mode
// is active — they just call openWidget()/closeWidget() and the
// provider does the right thing.

type WidgetSize = "mini" | "compact" | "full"

const SIZES: Record<
  WidgetSize,
  { w: number; h: number; label: string; description: string }
> = {
  mini: { w: 240, h: 120, label: "Mini", description: "Two prices" },
  compact: {
    w: 320,
    h: 200,
    label: "Compact",
    description: "Prices + 24h + ratio",
  },
  full: {
    w: 380,
    h: 300,
    label: "Full",
    description: "All metrics + market state",
  },
}

interface DocumentPipApi {
  requestWindow(opts: { width?: number; height?: number }): Promise<Window>
  window: Window | null
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPipApi
  }
  interface HTMLVideoElement {
    // iOS Safari's webkit-prefixed alternative to requestPictureInPicture.
    webkitSupportsPresentationMode?: (mode: string) => boolean
    webkitSetPresentationMode?: (mode: string) => void
  }
}

// Loose alias for the canvas-captured track. The standard
// CanvasCaptureMediaStreamTrack typing has subtle modifier diffs that
// differ across TS lib versions, so we duck-type it instead.
type CanvasCaptureTrack = MediaStreamTrack & { requestFrame?: () => void }

interface QuoteData {
  marketState?: string
  regularMarketPrice?: number | null
  preMarketPrice?: number | null
  postMarketPrice?: number | null
  overnightMarketPrice?: number | null
  preMarketTime?: number | null
  postMarketTime?: number | null
  overnightMarketTime?: number | null
}

interface PriceData {
  current?: {
    cyph?: { price?: number | null; change24h?: number | null }
    zec?: { price?: number | null; change24h?: number | null }
  }
  history?: { ratio: number | null }[]
  stats?: {
    cyph?: { change7d?: number | null; change30d?: number | null }
    zec?: { change7d?: number | null; change30d?: number | null }
  }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"
const SKY_COLOR = "#38bdf8"
const GREEN = "#34d399"
const RED = "#f87171"
const BG = "#0b0f14"
const FG = "#f5f5f5"
const MUTED = "#9ca3af"
const DIM = "#475569"

type PipMode = "document" | "video" | null

interface PipContextValue {
  mode: PipMode
  supported: boolean
  pipActive: boolean
  size: WidgetSize
  setSize: (s: WidgetSize) => void
  autoReopen: boolean
  setAutoReopen: (v: boolean) => void
  openWidget: () => Promise<void>
  closeWidget: () => Promise<void>
  bannerDismissed: boolean
  dismissBanner: () => void
}

const PipContext = createContext<PipContextValue | null>(null)

function usePip(): PipContextValue {
  const ctx = useContext(PipContext)
  if (!ctx) throw new Error("PiP component used outside <PipProvider>")
  return ctx
}

// ─── widget data shape (shared by both render paths) ────────────────────────

interface WidgetData {
  cyph: number | null
  zec: number | null
  cyphCh: number | null
  zecCh: number | null
  ratio: number | null
  marketTag: string | null
  isExt: boolean
  cyph7d: number | null
  cyph30d: number | null
  zec7d: number | null
  zec30d: number | null
}

function pickLiveCyph(q: QuoteData | undefined): {
  price: number | null
  state: string | null
  isExt: boolean
} {
  if (!q) return { price: null, state: null, isExt: false }
  if (q.marketState === "REGULAR") {
    return {
      price: q.regularMarketPrice ?? null,
      state: "REGULAR",
      isExt: false,
    }
  }
  const candidates: { price: number; t: number; tag: string }[] = []
  if (q.overnightMarketPrice != null && q.overnightMarketTime != null) {
    candidates.push({
      price: q.overnightMarketPrice,
      t: q.overnightMarketTime,
      tag: "OVERNIGHT",
    })
  }
  if (q.postMarketPrice != null && q.postMarketTime != null) {
    candidates.push({ price: q.postMarketPrice, t: q.postMarketTime, tag: "AH" })
  }
  if (q.preMarketPrice != null && q.preMarketTime != null) {
    candidates.push({ price: q.preMarketPrice, t: q.preMarketTime, tag: "PRE" })
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.t - a.t)
    return {
      price: candidates[0].price,
      state: candidates[0].tag,
      isExt: true,
    }
  }
  return { price: q.regularMarketPrice ?? null, state: "CLOSED", isExt: false }
}

function buildWidgetData(
  prices: PriceData | undefined,
  quote: QuoteData | undefined
): WidgetData {
  const live = pickLiveCyph(quote)
  const cyph = live.price ?? prices?.current?.cyph?.price ?? null
  const zec = prices?.current?.zec?.price ?? null
  return {
    cyph,
    zec,
    cyphCh: prices?.current?.cyph?.change24h ?? null,
    zecCh: prices?.current?.zec?.change24h ?? null,
    ratio: cyph != null && zec != null && zec > 0 ? cyph / zec : null,
    marketTag: live.state,
    isExt: live.isExt,
    cyph7d: prices?.stats?.cyph?.change7d ?? null,
    cyph30d: prices?.stats?.cyph?.change30d ?? null,
    zec7d: prices?.stats?.zec?.change7d ?? null,
    zec30d: prices?.stats?.zec?.change30d ?? null,
  }
}

// ─── provider ──────────────────────────────────────────────────────────────

export function PipProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PipMode>(null)
  useEffect(() => {
    if (typeof window === "undefined") return
    const docPipOk =
      typeof window.documentPictureInPicture?.requestWindow === "function"
    if (docPipOk) {
      setMode("document")
      return
    }
    const videoPipOk =
      typeof document !== "undefined" &&
      ((typeof document.pictureInPictureEnabled === "boolean" &&
        document.pictureInPictureEnabled) ||
        // iOS Safari exposes the webkit-prefixed presentation mode API
        // on prototypes even when the standard property is undefined.
        typeof HTMLVideoElement.prototype.webkitSupportsPresentationMode ===
          "function")
    if (videoPipOk) {
      setMode("video")
      return
    }
    setMode(null)
    // eslint-disable-next-line no-console
    console.info(
      "[cyphzec] No Picture-in-Picture API available on this browser. " +
        "Document PiP requires Chrome 116+ (desktop) / Chrome Android 126+. " +
        "Video PiP requires Chrome 70+ / Edge 18+ / Safari iOS 14+ / Firefox 110+."
    )
  }, [])

  const supported = mode !== null

  // Persisted view state.
  const [size, setSize] = usePersistentState<WidgetSize>(
    "cyphzec.pip.size",
    "compact",
    (v): v is WidgetSize =>
      v === "mini" || v === "compact" || v === "full"
  )
  const [autoReopen, setAutoReopen] = usePersistentState<boolean>(
    "cyphzec.pip.autoReopen",
    false,
    (v): v is boolean => typeof v === "boolean"
  )
  const [bannerDismissed, setBannerDismissed] = usePersistentState<boolean>(
    "cyphzec.pip.bannerDismissed",
    false,
    (v): v is boolean => typeof v === "boolean"
  )

  // Document-PiP state.
  const [pipWindow, setPipWindow] = useState<Window | null>(null)

  // Video-PiP state. Refs are mounted into the hidden <canvas>/<video>
  // pair below — kept off-screen since the OS PiP renderer reads the
  // bitmap directly off the captured stream.
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [videoPipActive, setVideoPipActive] = useState(false)

  // Transient flag: true after the user explicitly closed the widget
  // this session. Suppresses auto-reopen-on-next-click behaviour so a
  // user who deliberately dismissed doesn't get the widget popping
  // back the moment they tap something. Reset when they open again.
  const userClosedRef = useRef(false)

  const pipActive = mode === "document" ? pipWindow !== null : videoPipActive

  // Track the most recent successful upstream fetch so we can render
  // an "Updated Xs ago" footer in the widget. The timestamp is set
  // via onSuccess on each SWR hook below, which fires even when the
  // returned data is structurally identical to the previous fetch
  // (so users still see liveness when nothing's actually changing).
  const [lastUpdate, setLastUpdate] = useState<number>(() => Date.now())
  // Pip-active tick: re-renders the elapsed text every 5s while the
  // widget is open so the displayed value stays current between SWR
  // refreshes. Stops when the widget is closed to avoid pointless
  // background work.
  const [now, setNow] = useState<number>(() => Date.now())

  // Live data — single source of truth for both render paths. SWR
  // dedupes against the dashboard's own subscriptions so we don't
  // double-fetch when both surfaces are mounted.
  //
  // Polling cadence escalates while the widget is open: more
  // important to keep the floating tile fresh than to be polite to
  // CoinGecko / Yahoo. refreshWhenHidden + the focus/reconnect
  // revalidations together make sure background tabs (or a
  // backgrounded PWA) keep fetching — without those the OS pauses
  // SWR's setInterval and the widget freezes on stale numbers.
  const baseSwrOpts = {
    refreshWhenHidden: true,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
    onSuccess: () => setLastUpdate(Date.now()),
  }
  const { data: prices } = useSWR<PriceData>(
    "/api/prices?days=7",
    fetcher,
    {
      ...baseSwrOpts,
      // Twice as fast while the floating widget is up — users open it
      // to watch ZEC tick, and a 60s gap feels stale on a phone home
      // screen. SWR picks up the new interval mid-flight.
      refreshInterval: pipActive ? 30_000 : 60_000,
    }
  )
  const { data: quote } = useSWR<QuoteData>("/api/quote", fetcher, {
    ...baseSwrOpts,
    refreshInterval: pipActive ? 15_000 : 30_000,
  })
  const widgetData = useMemo(
    () => buildWidgetData(prices, quote),
    [prices, quote]
  )

  // Tick `now` every 5s while the widget is up so the "Updated Xs
  // ago" footer stays current between data refreshes. Stops when the
  // widget is closed so we're not running a heartbeat for nothing.
  useEffect(() => {
    if (!pipActive) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [pipActive])

  // Whenever data, size, the lastUpdate timestamp, or the 5s tick
  // changes, redraw the canvas (video mode only — document mode
  // rerenders React directly). After drawing, ask the captureStream
  // track to push a fresh frame so the OS PiP window updates
  // immediately.
  useEffect(() => {
    if (mode !== "video") return
    const canvas = canvasRef.current
    if (!canvas) return
    drawCanvasWidget(canvas, widgetData, size, lastUpdate, now)
    const track = streamRef.current?.getVideoTracks()[0] as
      | CanvasCaptureTrack
      | undefined
    if (track?.requestFrame) track.requestFrame()
  }, [mode, widgetData, size, lastUpdate, now])

  // Listen for the user closing the PiP window via the OS chrome
  // (the X on the floating window). We need to mirror that into our
  // own state so the button flips back to "Pop-out widget".
  // Two listeners:
  //   - leavepictureinpicture: standard event, fires on Chrome/Edge
  //     and Safari iOS 14+.
  //   - webkitpresentationmodechanged: older Safari iOS / desktop
  //     Safari fallback. We check the new presentation mode and
  //     consider anything other than "picture-in-picture" as "left".
  useEffect(() => {
    if (mode !== "video") return
    const video = videoRef.current
    if (!video) return
    const onLeave = () => setVideoPipActive(false)
    const onWebkitChange = () => {
      // The video element exposes the current mode as a property.
      // Anything other than "picture-in-picture" means we're back
      // inline / fullscreen — flip our state.
      const m = (video as unknown as { webkitPresentationMode?: string })
        .webkitPresentationMode
      if (m && m !== "picture-in-picture") setVideoPipActive(false)
    }
    video.addEventListener("leavepictureinpicture", onLeave)
    video.addEventListener(
      "webkitpresentationmodechanged",
      onWebkitChange as EventListener
    )
    return () => {
      video.removeEventListener("leavepictureinpicture", onLeave)
      video.removeEventListener(
        "webkitpresentationmodechanged",
        onWebkitChange as EventListener
      )
    }
  }, [mode])

  // Stream cleanup. When the provider unmounts (or mode flips, e.g.
  // the API became unavailable mid-session due to feature-policy
  // change), stop the captured tracks and clear srcObject so the
  // browser releases the canvas-stream binding. Without this, dev-
  // mode hot reloads + future SPA-style nav would leak tracks.
  useEffect(() => {
    if (mode !== "video") return
    return () => {
      const stream = streamRef.current
      if (stream) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop()
          } catch {
            /* best-effort */
          }
        })
        streamRef.current = null
      }
      const video = videoRef.current
      if (video) {
        try {
          video.pause()
        } catch {
          /* best-effort */
        }
        video.srcObject = null
      }
    }
  }, [mode])

  const openInFlightRef = useRef(false)
  const openWidget = useCallback(async () => {
    if (typeof window === "undefined" || openInFlightRef.current) return
    if (mode === "document" && pipWindow) return
    if (mode === "video" && videoPipActive) return
    openInFlightRef.current = true
    try {
      if (mode === "document") {
        const pip = await window.documentPictureInPicture!.requestWindow({
          width: SIZES[size].w,
          height: SIZES[size].h,
        })

        const head = pip.document.head
        Array.from(document.styleSheets).forEach((ss) => {
          try {
            const rules = Array.from(ss.cssRules ?? [])
              .map((r) => r.cssText)
              .join("")
            if (rules) {
              const style = pip.document.createElement("style")
              style.textContent = rules
              head.appendChild(style)
            } else if (ss.href) {
              const link = pip.document.createElement("link")
              link.rel = "stylesheet"
              link.href = ss.href
              head.appendChild(link)
            }
          } catch {
            if (ss.href) {
              const link = pip.document.createElement("link")
              link.rel = "stylesheet"
              link.href = ss.href
              head.appendChild(link)
            }
          }
        })

        pip.document.body.style.margin = "0"
        pip.document.body.style.background = BG
        pip.document.body.style.color = FG
        pip.document.body.style.fontFamily =
          "ui-monospace, SFMono-Regular, Menlo, monospace"
        pip.document.title = "$CYPH / $ZEC"

        pip.addEventListener("pagehide", () => setPipWindow(null))
        setPipWindow(pip)
      } else if (mode === "video") {
        const canvas = canvasRef.current
        const video = videoRef.current
        if (!canvas || !video) return

        // Setup must stay synchronous up through requestPictureInPicture.
        // Browsers gate the PiP API behind transient user activation,
        // and any `await` in the open path that's not on the PiP call
        // itself can invalidate the activation token — silently
        // rejecting requestPictureInPicture with NotAllowedError.
        // That was the bug: with the polling loop in place the open
        // worked from the page (where SWR + state churn changes
        // between activation and the API call), but the auto-reopen
        // gesture (a quick click after a refresh) lost activation
        // somewhere in the await chain and the call no-op'd.
        //
        // The browser will internally wait for the video to become
        // ready before showing the PiP window, so we don't need to
        // poll here. The HTML width/height attrs on the video element
        // serve as a pre-metadata aspect-ratio fallback for the OS.

        // 1) Resize the canvas + draw current content.
        drawCanvasWidget(canvas, widgetData, size, lastUpdate, now)

        // 2) Tear down any prior stream so a size change between
        //    opens picks up fresh metadata instead of inheriting
        //    stale dimensions from the previous session's track.
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => {
            try {
              t.stop()
            } catch {
              /* best-effort */
            }
          })
          streamRef.current = null
        }

        // 3) Create a fresh stream + bind it to the video.
        const stream = canvas.captureStream(0)
        streamRef.current = stream
        video.srcObject = stream

        // 4) Push the initial frame so the track has bitmap data —
        //    Chrome internally uses this to populate video metadata
        //    once the video element gets around to processing it.
        const track = stream.getVideoTracks()[0] as
          | CanvasCaptureTrack
          | undefined
        if (track?.requestFrame) track.requestFrame()

        video.muted = true
        video.playsInline = true
        // 5) Kick off play but DO NOT await — awaiting a paused
        //    video's play() can sit for tens of ms and consume our
        //    activation budget. play() itself synchronously updates
        //    the video state; the returned Promise just resolves
        //    later. .catch silences autoplay-policy rejections.
        video.play().catch(() => {})

        // 6) Open PiP. Single await, immediately after the synchronous
        //    setup, so transient activation is still valid. Chrome
        //    will internally wait for video readyState >= HAVE_METADATA
        //    before rendering the floating window — no polling needed.
        if (typeof video.requestPictureInPicture === "function") {
          try {
            await video.requestPictureInPicture()
          } catch (e) {
            // Diagnostic dump — without this, NotAllowedError /
            // InvalidStateError just disappear into the void and
            // users see nothing happen.
            // eslint-disable-next-line no-console
            console.error("[cyphzec] requestPictureInPicture rejected:", e, {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              paused: video.paused,
              srcObject: !!video.srcObject,
            })
            throw e
          }
        } else if (typeof video.webkitSetPresentationMode === "function") {
          // iOS Safari fallback. Doesn't return a promise.
          video.webkitSetPresentationMode("picture-in-picture")
        }
        setVideoPipActive(true)
      }
      setBannerDismissed(true)
      // Reset the explicit-close suppression flag — user is opening
      // again, so future closes should be honored independently.
      userClosedRef.current = false
      // sessionStorage flag survives a page refresh during this tab
      // session. The auto-reopen useEffect picks this up on remount
      // and attaches a one-shot listener so the widget re-pops on
      // the user's first interaction with the reloaded page.
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem("cyphzec.pip.wasOpen", "1")
        }
      } catch {
        /* private mode / quota — non-fatal */
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("PiP open failed:", e)
    } finally {
      openInFlightRef.current = false
    }
  }, [
    mode,
    pipWindow,
    videoPipActive,
    size,
    widgetData,
    lastUpdate,
    now,
    setBannerDismissed,
  ])

  const closeWidget = useCallback(async () => {
    if (mode === "document") {
      pipWindow?.close()
      setPipWindow(null)
    } else if (mode === "video") {
      try {
        if (
          typeof document !== "undefined" &&
          document.pictureInPictureElement &&
          typeof document.exitPictureInPicture === "function"
        ) {
          await document.exitPictureInPicture()
        } else if (
          videoRef.current &&
          typeof videoRef.current.webkitSetPresentationMode === "function"
        ) {
          videoRef.current.webkitSetPresentationMode("inline")
        }
      } catch {
        /* best-effort */
      }
      setVideoPipActive(false)
    }
    // User-initiated close: suppress auto-reopen for the rest of this
    // widget cycle so they don't get the widget back the next time
    // they tap anywhere on the page. Also clear the session-persist
    // flag so a subsequent refresh doesn't re-pop it either.
    userClosedRef.current = true
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("cyphzec.pip.wasOpen")
      }
    } catch {
      /* non-fatal */
    }
  }, [mode, pipWindow])

  const dismissBanner = useCallback(() => setBannerDismissed(true), [
    setBannerDismissed,
  ])

  // Auto-reopen: both PiP APIs require a transient user gesture, so we
  // can't open on mount — we attach a one-shot click/keydown listener
  // that opens the widget on the user's next interaction. Two triggers:
  //   - autoReopen: user-set localStorage preference, "always reopen"
  //   - wasOpen:   sessionStorage flag set when openWidget last ran;
  //                survives a tab refresh, cleared on explicit close
  //                or tab close. Means "the widget was open before
  //                this reload, restore it on first interaction".
  // userClosedRef short-circuits both — if the user just dismissed
  // the widget, we shouldn't keep popping it back at every click.
  useEffect(() => {
    if (!supported || pipActive || userClosedRef.current) return
    const wasOpen =
      typeof window !== "undefined" &&
      window.sessionStorage.getItem("cyphzec.pip.wasOpen") === "1"
    if (!autoReopen && !wasOpen) return
    let attached = true
    const onGesture = () => {
      if (!attached) return
      attached = false
      window.removeEventListener("click", onGesture)
      window.removeEventListener("keydown", onGesture)
      openWidget()
    }
    window.addEventListener("click", onGesture)
    window.addEventListener("keydown", onGesture)
    return () => {
      attached = false
      window.removeEventListener("click", onGesture)
      window.removeEventListener("keydown", onGesture)
    }
  }, [autoReopen, supported, pipActive, openWidget])

  const value = useMemo<PipContextValue>(
    () => ({
      mode,
      supported,
      pipActive,
      size,
      setSize,
      autoReopen,
      setAutoReopen,
      openWidget,
      closeWidget,
      bannerDismissed,
      dismissBanner,
    }),
    [
      mode,
      supported,
      pipActive,
      size,
      setSize,
      autoReopen,
      setAutoReopen,
      openWidget,
      closeWidget,
      bannerDismissed,
      dismissBanner,
    ]
  )

  return (
    <PipContext.Provider value={value}>
      {children}
      {/* Document-PiP portal. Only mounted when we have a live PiP
          window — closes cleanly when the user dismisses it. */}
      {mode === "document" &&
        pipWindow &&
        createPortal(
          <DocumentPipContent
            size={size}
            data={widgetData}
            lastUpdate={lastUpdate}
            now={now}
          />,
          pipWindow.document.body
        )}
      {/* Video-PiP off-screen rig. The canvas + video pair lives
          inside the React tree (always mounted in 'video' mode) so
          the captureStream relationship is stable across data
          updates. Both elements are positioned far off-screen and
          aria-hidden so screen-readers and keyboard nav skip them. */}
      {mode === "video" && (
        <div
          aria-hidden="true"
          style={{
            // Pushed off-screen, but deliberately NOT clipped to 1×1.
            // When the OS PiP API can't read videoWidth/videoHeight
            // yet (captureStream metadata is async), it falls back to
            // the video element's HTML/CSS dimensions — and a 1×1
            // wrapper made it size the floating window at 1×1 then
            // stretch our content into it, which is the "elongated /
            // squished on first open" bug. Letting the canvas + video
            // render at natural sizes off-screen costs nothing
            // visually but gives the OS sane fallbacks.
            position: "fixed",
            left: "-99999px",
            top: "-99999px",
            pointerEvents: "none",
          }}
        >
          <canvas ref={canvasRef} />
          {/* Explicit width/height attributes so even before the
              captureStream surfaces its metadata, the video element's
              HTML intrinsic dimensions match the canvas. The OS reads
              these as the fallback for PiP window sizing. */}
          <video
            ref={videoRef}
            muted
            playsInline
            width={SIZES[size].w}
            height={SIZES[size].h}
          />
        </div>
      )}
    </PipContext.Provider>
  )
}

// ─── banner + footer controls ──────────────────────────────────────────────

export function PipBanner() {
  const { supported, pipActive, bannerDismissed, dismissBanner, openWidget } =
    usePip()
  if (!supported || pipActive || bannerDismissed) return null
  return (
    <div className="rounded-lg border border-sky-500/40 bg-sky-500/[.07] flex items-center gap-2 px-3 py-2 text-xs font-mono">
      <PictureInPicture2 className="h-4 w-4 text-sky-400 flex-shrink-0" />
      <span className="text-foreground/90 flex-1 min-w-0">
        Pop $CYPH / $ZEC into a{" "}
        <span className="text-sky-300">floating widget</span>
        {" "}— always on top while you browse.
      </span>
      <button
        onClick={openWidget}
        className="px-2 py-1 rounded border border-sky-500/40 bg-sky-500/[.10] hover:bg-sky-500/[.18] hover:border-sky-500/70 text-sky-200 transition-colors flex-shrink-0 whitespace-nowrap"
      >
        Open widget
      </button>
      <button
        onClick={dismissBanner}
        aria-label="Dismiss"
        title="Dismiss this prompt"
        className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 p-0.5"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function PipFooterControls() {
  const {
    supported,
    pipActive,
    size,
    setSize,
    autoReopen,
    setAutoReopen,
    openWidget,
    closeWidget,
  } = usePip()
  if (!supported) return null
  const chipBase =
    "inline-flex items-center gap-1 h-[22px] px-1.5 rounded border border-border text-[11px] font-mono leading-none"
  return (
    <div className="inline-flex items-center gap-1.5">
      {pipActive ? (
        <button
          onClick={closeWidget}
          className={`${chipBase} hover:text-foreground hover:border-border/80 transition-colors`}
          title="Close the picture-in-picture widget"
        >
          <X className="h-3 w-3" />
          Close widget
        </button>
      ) : (
        <button
          onClick={openWidget}
          className={`${chipBase} hover:text-foreground hover:border-border/80 transition-colors`}
          title="Open a small always-on-top window with live prices"
        >
          <PictureInPicture2 className="h-3 w-3" />
          Pop-out widget
        </button>
      )}
      <select
        value={size}
        onChange={(e) => setSize(e.target.value as WidgetSize)}
        // Stays visible while active so users still see which size is
        // current, but disabled because the OS PiP window's aspect
        // doesn't update mid-session — they need to close + reopen
        // for a size change to take effect. Tooltip spells that out
        // so a disabled control doesn't feel broken.
        disabled={pipActive}
        className={`${chipBase} appearance-none bg-secondary pr-1.5 transition-colors ${
          pipActive
            ? "opacity-60 cursor-not-allowed"
            : "cursor-pointer hover:border-border/80"
        }`}
        title={
          pipActive
            ? "Close the widget to change size"
            : "Widget size"
        }
        aria-label="Widget size"
      >
        {(
          Object.entries(SIZES) as [WidgetSize, (typeof SIZES)[WidgetSize]][]
        ).map(([id, info]) => (
          <option key={id} value={id}>
            {info.label}
          </option>
        ))}
      </select>
      <label
        className={`${chipBase} cursor-pointer hover:text-foreground hover:border-border/80 transition-colors select-none`}
        title="Auto-open the widget on your next visit (after first click)"
      >
        <input
          type="checkbox"
          checked={autoReopen}
          onChange={(e) => setAutoReopen(e.target.checked)}
          className="h-3 w-3 accent-primary"
        />
        Auto
      </label>
    </div>
  )
}

// ─── Document-PiP content (React, runs in the PiP window's tree) ──────────

function fmtPrice(p: number | null | undefined) {
  if (p == null) return "—"
  return p < 1
    ? `$${p.toFixed(4)}`
    : `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRatio(r: number | null) {
  if (r == null) return "—"
  return r < 0.001 ? r.toExponential(3) : r.toPrecision(4)
}

/** "just now" / "Xs ago" / "Xm ago" / "Xh ago" — rounds sub-minute
 *  to the nearest 5s so the canvas doesn't redraw every second when
 *  the value would only change cosmetically. */
function fmtAgo(seconds: number): string {
  const s = Math.max(0, seconds)
  if (s < 5) return "just now"
  if (s < 60) return `${Math.round(s / 5) * 5}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function DocumentPipContent({
  size,
  data,
  lastUpdate,
  now,
}: {
  size: WidgetSize
  data: WidgetData
  lastUpdate: number
  now: number
}) {
  const showRatio = size !== "mini"
  const show24h = size !== "mini"
  const showState = size === "full"
  const showPerfChips = size === "full"
  const ago = fmtAgo((now - lastUpdate) / 1000)
  return (
    <div
      className="flex flex-col gap-2 p-3 h-screen w-screen"
      style={{ background: BG, color: FG }}
    >
      <div
        className="flex items-center justify-between text-[10px] uppercase tracking-wider"
        style={{ color: MUTED }}
      >
        <span aria-hidden="true" className="inline-flex items-center gap-1">
          <span style={{ color: CYPH_COLOR }}>$CYPH</span>
          <span style={{ opacity: 0.6 }}>/</span>
          <span style={{ color: ZEC_COLOR }}>$ZEC</span>
        </span>
        {showState && data.marketTag && (
          <StateBadge state={data.marketTag} isExt={data.isExt} />
        )}
      </div>

      <div className="flex items-stretch gap-3 flex-1 min-h-0">
        <PriceCol
          label="$CYPH"
          color={CYPH_COLOR}
          price={data.cyph}
          change24h={show24h ? data.cyphCh : null}
          size={size}
        />
        <div
          className="w-px self-stretch"
          style={{ backgroundColor: "#1f2937" }}
          aria-hidden="true"
        />
        <PriceCol
          label="$ZEC"
          color={ZEC_COLOR}
          price={data.zec}
          change24h={show24h ? data.zecCh : null}
          size={size}
        />
      </div>

      {showRatio && (
        <div className="flex items-baseline justify-between text-[11px]">
          <span style={{ color: MUTED }}>Ratio</span>
          <span className="font-mono font-bold" style={{ color: SKY_COLOR }}>
            {fmtRatio(data.ratio)}
          </span>
        </div>
      )}

      {showPerfChips && (
        <div className="flex flex-col gap-1 text-[10px]">
          <PerfRow
            label="$CYPH"
            color={CYPH_COLOR}
            d7={data.cyph7d}
            d30={data.cyph30d}
          />
          <PerfRow
            label="$ZEC"
            color={ZEC_COLOR}
            d7={data.zec7d}
            d30={data.zec30d}
          />
        </div>
      )}

      {/* Subtle freshness footer — same data the canvas widget paints
          in its bottom-right corner. Right-aligned so it sits below
          the ratio value, never competing for the eye-line of the
          headline price block above. */}
      <div
        className="text-[9px] font-mono text-right -mt-1"
        style={{ color: MUTED, opacity: 0.55 }}
        title={`Last refreshed ${new Date(lastUpdate).toLocaleTimeString()}`}
      >
        Updated {ago}
      </div>
    </div>
  )
}

function PriceCol({
  label,
  color,
  price,
  change24h,
  size,
}: {
  label: string
  color: string
  price: number | null
  change24h: number | null
  size: WidgetSize
}) {
  const priceClass =
    size === "mini"
      ? "text-2xl"
      : size === "compact"
        ? "text-2xl"
        : "text-3xl"
  const isUp = (change24h ?? 0) >= 0
  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-0 justify-center">
      <span
        className="text-[10px] uppercase tracking-wider font-mono"
        style={{ color }}
      >
        {label}
      </span>
      <span
        className={`${priceClass} font-mono font-bold leading-none truncate`}
      >
        {fmtPrice(price)}
      </span>
      {change24h != null && (
        <span
          className="text-[10px] font-mono"
          style={{ color: isUp ? GREEN : RED }}
        >
          {isUp ? "+" : ""}
          {change24h.toFixed(2)}% 24h
        </span>
      )}
    </div>
  )
}

function PerfRow({
  label,
  color,
  d7,
  d30,
}: {
  label: string
  color: string
  d7: number | null
  d30: number | null
}) {
  return (
    <div className="flex items-center justify-between gap-2 font-mono">
      <span style={{ color }}>{label}</span>
      <span className="flex items-center gap-2">
        <PerfNum label="7D" pct={d7} />
        <PerfNum label="30D" pct={d30} />
      </span>
    </div>
  )
}

function PerfNum({ label, pct }: { label: string; pct: number | null }) {
  if (pct == null) return <span style={{ opacity: 0.6 }}>{label} —</span>
  const isUp = pct >= 0
  return (
    <span style={{ color: isUp ? GREEN : RED }}>
      {label} {isUp ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  )
}

function StateBadge({ state, isExt }: { state: string; isExt: boolean }) {
  const isClosed = state === "CLOSED"
  const isRegular = state === "REGULAR"
  const Icon = isExt ? Moon : isClosed ? Clock : Sun
  const color = isClosed
    ? MUTED
    : isRegular
      ? GREEN
      : isExt
        ? "#a78bfa"
        : MUTED
  return (
    <span
      className="inline-flex items-center gap-1 px-1 py-0.5 rounded border"
      style={{ borderColor: `${color}66`, color }}
    >
      <Icon className="h-2.5 w-2.5" />
      {state}
    </span>
  )
}

// ─── canvas drawing for video PiP path ─────────────────────────────────────

const FONT_FAMILY =
  '"SF Mono", "Cascadia Mono", "Roboto Mono", ui-monospace, Menlo, monospace'

/** Draws the widget for the requested size. The bitmap is sized to
 *  width × DPR so text stays crisp inside the OS PiP renderer (which
 *  reads the captureStream() bitmap directly). The OS picks the
 *  actual floating-window pixel size — what we control is the
 *  aspect ratio (via the canvas's intrinsic dimensions) and the
 *  layout density. Mini is a wide 2:1 bar, Compact is 8:5, Full is
 *  near-square 5:4 — each size produces a visibly different shape
 *  on the user's screen even though we can't pin pixel sizes. */
function drawCanvasWidget(
  canvas: HTMLCanvasElement,
  data: WidgetData,
  size: WidgetSize,
  lastUpdate: number,
  now: number
) {
  const { w, h } = SIZES[size]
  // Cap DPR at 2 — anything higher just inflates the stream bitrate
  // for a vanishing visual gain at this small size.
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.textBaseline = "alphabetic"

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, w, h)

  const padX = 12

  if (size === "mini") {
    // Mini: just two big prices side by side. No header chrome —
    // the OS window itself is the "container", and at this aspect
    // ratio (2:1) any extra label takes space away from what
    // matters. Color-coded $CYPH / $ZEC ticker is dropped under the
    // price as a tiny subscript so users still know which side is
    // which.
    const colW = (w - padX * 2 - 12) / 2
    drawMiniCol(ctx, padX, 0, colW, h, "$CYPH", CYPH_COLOR, data.cyph)
    const dividerX = padX + colW + 6
    ctx.strokeStyle = "#1f2937"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(dividerX, 12)
    ctx.lineTo(dividerX, h - 12)
    ctx.stroke()
    drawMiniCol(
      ctx,
      padX + colW + 12,
      0,
      colW,
      h,
      "$ZEC",
      ZEC_COLOR,
      data.zec
    )
    drawAgoFooter(ctx, w, h, lastUpdate, now)
    return
  }

  // Compact + Full share the same header strip + two-column price
  // layout. Full adds a market-state badge and stacks the perf rows
  // below the ratio row.
  let y = 22
  ctx.font = `600 11px ${FONT_FAMILY}`
  const cyphLabel = "$CYPH"
  const sepLabel = " / "
  const zecLabel = "$ZEC"
  ctx.fillStyle = CYPH_COLOR
  ctx.fillText(cyphLabel, padX, y)
  let x = padX + ctx.measureText(cyphLabel).width
  ctx.fillStyle = MUTED
  ctx.fillText(sepLabel, x, y)
  x += ctx.measureText(sepLabel).width
  ctx.fillStyle = ZEC_COLOR
  ctx.fillText(zecLabel, x, y)

  if (size === "full" && data.marketTag) {
    const tag = data.marketTag
    ctx.font = `600 10px ${FONT_FAMILY}`
    const tw = ctx.measureText(tag).width
    const bx = w - padX - tw - 12
    const by = y - 12
    const bh = 16
    const color =
      tag === "REGULAR"
        ? GREEN
        : tag === "CLOSED"
          ? MUTED
          : data.isExt
            ? "#a78bfa"
            : MUTED
    ctx.strokeStyle = `${color}66`
    ctx.fillStyle = `${color}22`
    roundRect(ctx, bx, by, tw + 12, bh, 4)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = color
    ctx.fillText(tag, bx + 6, by + 11)
  }

  // Two-column price block
  const colTop = y + 8
  const colBottom = size === "compact" ? h - 30 : h - 90
  const colW = (w - padX * 2 - 14) / 2
  drawPriceCol(
    ctx,
    padX,
    colTop,
    colW,
    colBottom - colTop,
    "$CYPH",
    CYPH_COLOR,
    data.cyph,
    data.cyphCh,
    size
  )
  const dividerX = padX + colW + 7
  ctx.strokeStyle = "#1f2937"
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(dividerX, colTop)
  ctx.lineTo(dividerX, colBottom)
  ctx.stroke()
  drawPriceCol(
    ctx,
    padX + colW + 14,
    colTop,
    colW,
    colBottom - colTop,
    "$ZEC",
    ZEC_COLOR,
    data.zec,
    data.zecCh,
    size
  )

  // Ratio row — pushed up far enough to leave room for the bottom-
  // right "Updated Xs ago" footer on both sizes.
  const ratioY = size === "compact" ? h - 22 : h - 70
  ctx.font = `500 10px ${FONT_FAMILY}`
  ctx.fillStyle = MUTED
  ctx.fillText("Ratio", padX, ratioY)
  ctx.font = `700 12px ${FONT_FAMILY}`
  const ratioTxt = fmtRatio(data.ratio)
  ctx.fillStyle = SKY_COLOR
  const ratioW = ctx.measureText(ratioTxt).width
  ctx.fillText(ratioTxt, w - padX - ratioW, ratioY)

  // Perf rows (full only)
  if (size === "full") {
    drawPerfRow(
      ctx,
      padX,
      h - 44,
      w - padX * 2,
      "$CYPH",
      CYPH_COLOR,
      data.cyph7d,
      data.cyph30d
    )
    drawPerfRow(
      ctx,
      padX,
      h - 22,
      w - padX * 2,
      "$ZEC",
      ZEC_COLOR,
      data.zec7d,
      data.zec30d
    )
  }

  drawAgoFooter(ctx, w, h, lastUpdate, now)
}

/** Tiny "Updated Xs ago" stamp. Mini draws it bottom-center because
 *  there's no other footer there; compact and full tuck it into the
 *  bottom-left so it doesn't compete with the ratio value on the
 *  right. Always faded — informational, not a chip. */
function drawAgoFooter(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lastUpdate: number,
  now: number
) {
  const seconds = Math.max(0, (now - lastUpdate) / 1000)
  const text = fmtAgo(seconds)
  ctx.font = `400 9px ${FONT_FAMILY}`
  ctx.fillStyle = MUTED
  ctx.globalAlpha = 0.55
  // Tuck against the bottom edge with a 4px breathing room. Drawn
  // at the bottom-right so it never collides with the per-coin
  // labels on the left edge of each row.
  const tw = ctx.measureText(text).width
  ctx.fillText(text, w - 12 - tw, h - 6)
  ctx.globalAlpha = 1
}

/** Mini-only column drawer — no 24h-change subtext, larger price
 *  font, ticker label nudged below the price as a small caption. */
function drawMiniCol(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  label: string,
  color: string,
  price: number | null
) {
  // Center the price + caption stack vertically in the column.
  const priceFontStart = 30
  const captionFontPx = 10
  const cy = y + ch / 2
  ctx.font = `700 ${priceFontStart}px ${FONT_FAMILY}`
  let usedFontPx = priceFontStart
  const text = fmtPrice(price)
  while (usedFontPx > 14 && ctx.measureText(text).width > cw - 4) {
    usedFontPx -= 1
    ctx.font = `700 ${usedFontPx}px ${FONT_FAMILY}`
  }
  ctx.fillStyle = FG
  // Baseline the price slightly above center so the caption fits below.
  ctx.fillText(text, x, cy + usedFontPx / 3 - 2)
  // Small ticker caption underneath, color-coded.
  ctx.font = `600 ${captionFontPx}px ${FONT_FAMILY}`
  ctx.fillStyle = color
  ctx.fillText(label, x, cy + usedFontPx / 3 + captionFontPx + 2)
}

function drawPriceCol(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  label: string,
  color: string,
  price: number | null,
  change24h: number | null,
  size: WidgetSize
) {
  // Mini font scale is the same as compact; full bumps up.
  const priceFontPx =
    size === "mini" ? 22 : size === "compact" ? 24 : 30
  const labelFontPx = 10
  const changeFontPx = 10

  // Vertically center the price block in the column.
  let cy = y + ch / 2 - priceFontPx / 2
  // Push down slightly so the label sits above the price.
  cy += 6

  // Label
  ctx.font = `600 ${labelFontPx}px ${FONT_FAMILY}`
  ctx.fillStyle = color
  ctx.fillText(label, x, cy - priceFontPx + 2)

  // Price
  ctx.font = `700 ${priceFontPx}px ${FONT_FAMILY}`
  ctx.fillStyle = FG
  const priceText = fmtPrice(price)
  // Shrink-to-fit: if the formatted price exceeds the column width,
  // step the font down until it fits. Avoids overflow on big mcap
  // numbers in tight column widths.
  let usedFontPx = priceFontPx
  while (
    usedFontPx > 12 &&
    ctx.measureText(priceText).width > cw - 4
  ) {
    usedFontPx -= 1
    ctx.font = `700 ${usedFontPx}px ${FONT_FAMILY}`
  }
  ctx.fillText(priceText, x, cy)

  // 24h change
  if (change24h != null) {
    ctx.font = `500 ${changeFontPx}px ${FONT_FAMILY}`
    ctx.fillStyle = change24h >= 0 ? GREEN : RED
    const sign = change24h >= 0 ? "+" : ""
    ctx.fillText(`${sign}${change24h.toFixed(2)}% 24h`, x, cy + 14)
  }
}

function drawPerfRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rowW: number,
  label: string,
  color: string,
  d7: number | null,
  d30: number | null
) {
  ctx.font = `600 10px ${FONT_FAMILY}`
  ctx.fillStyle = color
  ctx.fillText(label, x, y)

  // Right-align the two perf values so they line up across rows.
  ctx.font = `500 10px ${FONT_FAMILY}`
  const d30Text = perfText("30D", d30)
  const d7Text = perfText("7D", d7)
  const d30W = ctx.measureText(d30Text).width
  const d7W = ctx.measureText(d7Text).width
  const gap = 12
  const rightX = x + rowW
  const d30X = rightX - d30W
  const d7X = d30X - gap - d7W
  ctx.fillStyle = perfColor(d7)
  ctx.fillText(d7Text, d7X, y)
  ctx.fillStyle = perfColor(d30)
  ctx.fillText(d30Text, d30X, y)
}

function perfText(label: string, pct: number | null) {
  if (pct == null) return `${label} —`
  const sign = pct >= 0 ? "+" : ""
  return `${label} ${sign}${pct.toFixed(1)}%`
}

function perfColor(pct: number | null) {
  if (pct == null) return MUTED
  return pct >= 0 ? GREEN : RED
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}
