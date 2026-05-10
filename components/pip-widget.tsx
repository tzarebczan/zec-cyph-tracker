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
  /** Mobile auto-PiP-on-minimize is unreliable on Chrome Android —
   *  the autopictureinpicture attribute is honored inconsistently
   *  across versions and the visibilitychange fallback often opens
   *  a blank floater showing just the Chrome browser chrome. We
   *  expose this flag so the footer hides the Auto checkbox there
   *  rather than offering a feature we can't deliver cleanly. */
  isAndroid: boolean
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
  const [isAndroid, setIsAndroid] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    setIsAndroid(
      typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
    )
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
  // Tracks whether the pre-warm video has actually started playing
  // and reached HAVE_METADATA. Android Chrome's requestPictureInPicture
  // rejects with InvalidStateError if the video isn't there yet, so
  // the auto-reopen one-shot listener waits on this before attaching
  // — otherwise an Auto-on user clicking immediately after a refresh
  // hits the listener while video is still HAVE_NOTHING and the open
  // call silently rejects.
  const [videoReady, setVideoReady] = useState(false)

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

  // Pre-warm the stream + start the video as soon as we know we're
  // in video-PiP mode (and again whenever size changes). Android
  // Chrome's requestPictureInPicture() rejects with InvalidStateError
  // when the video is in HAVE_NOTHING state — desktop Chrome is more
  // forgiving and waits internally, but mobile is strict. By kicking
  // off play() the moment mode is detected, the video has been
  // running for hundreds of ms by the time the user clicks Pop-out,
  // so requestPictureInPicture sees readyState >= HAVE_METADATA and
  // succeeds immediately within the user-gesture window.
  useEffect(() => {
    if (mode !== "video") return
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    // Resize canvas + draw current data at the chosen size.
    drawCanvasWidget(canvas, widgetData, size, lastUpdate, now)

    // Tear down any prior stream — important on size changes so the
    // new dimensions become the stream's intrinsic dimensions.
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

    const stream = canvas.captureStream(0)
    streamRef.current = stream
    video.srcObject = stream

    const track = stream.getVideoTracks()[0] as
      | CanvasCaptureTrack
      | undefined
    if (track?.requestFrame) track.requestFrame()

    video.muted = true
    video.playsInline = true
    // Reset readiness on each pre-warm cycle (mode or size change)
    // so a stale "ready" doesn't leak from an earlier session.
    setVideoReady(false)
    let cancelled = false
    // muted=true means autoplay policies allow play() without a user
    // gesture. We track when play resolves so the auto-reopen one-
    // shot listener knows when the video is actually ready for PiP.
    video
      .play()
      .then(() => {
        if (!cancelled) setVideoReady(true)
      })
      .catch(() => {
        // Some browsers reject muted autoplay with no clear cause.
        // Mark ready anyway — when the user clicks, we'll try
        // playing again inside their gesture (which always works)
        // and requestPictureInPicture proceeds from there.
        if (!cancelled) setVideoReady(true)
      })

    return () => {
      // Don't tear down the stream here — that would defeat the
      // purpose of pre-warming. Just cancel the pending readiness
      // flip so a new pre-warm cycle (e.g. size change) doesn't
      // get clobbered by an earlier still-pending play() promise.
      cancelled = true
    }
  }, [mode, size])

  // Whenever data, lastUpdate, or the 5s ticker changes, redraw the
  // canvas and push a fresh frame so the OS PiP window updates.
  // Size is intentionally NOT in this effect's deps — size changes
  // are handled by the pre-warm effect above (which recreates the
  // stream so dimensions update properly).
  useEffect(() => {
    if (mode !== "video") return
    const canvas = canvasRef.current
    if (!canvas) return
    drawCanvasWidget(canvas, widgetData, size, lastUpdate, now)
    const track = streamRef.current?.getVideoTracks()[0] as
      | CanvasCaptureTrack
      | undefined
    if (track?.requestFrame) track.requestFrame()
  }, [mode, widgetData, lastUpdate, now, size])

  // Listen for the user closing the PiP window via the OS chrome
  // (the X on the floating window). We need to mirror that into our
  // own state so the button flips back to "Pop-out widget".
  // Two listeners:
  //   - leavepictureinpicture: standard event, fires on Chrome/Edge
  //     and Safari iOS 14+.
  //   - webkitpresentationmodechanged: older Safari iOS / desktop
  //     Safari fallback. We check the new presentation mode and
  //     consider anything other than "picture-in-picture" as "left".
  //   - enterpictureinpicture: fires when the browser auto-pips us
  //     because of the autopictureinpicture attribute (page going
  //     hidden) — we mirror that into our state so the close button
  //     in the footer flips to "Close widget" promptly.
  useEffect(() => {
    if (mode !== "video") return
    const video = videoRef.current
    if (!video) return
    const onEnter = () => setVideoPipActive(true)
    const onLeave = () => setVideoPipActive(false)
    const onWebkitChange = () => {
      const m = (video as unknown as { webkitPresentationMode?: string })
        .webkitPresentationMode
      if (m === "picture-in-picture") setVideoPipActive(true)
      else if (m) setVideoPipActive(false)
    }
    video.addEventListener("enterpictureinpicture", onEnter)
    video.addEventListener("leavepictureinpicture", onLeave)
    video.addEventListener(
      "webkitpresentationmodechanged",
      onWebkitChange as EventListener
    )
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter)
      video.removeEventListener("leavepictureinpicture", onLeave)
      video.removeEventListener(
        "webkitpresentationmodechanged",
        onWebkitChange as EventListener
      )
    }
  }, [mode])

  // Keep the pre-warm video alive across PWA backgrounding cycles.
  // When the user app-switches away on Android, Chrome pauses the
  // muted video to save energy; when they return, the page is
  // visible again but the video stays paused — and a click on
  // Pop-out then opens PiP around a stale/black frame. Listening for
  // visibilitychange and resuming play() inside the click that
  // follows is too late on some Android builds (autoplay policies
  // require fresh user interaction once the page has been hidden
  // long enough), so we resume eagerly on visibility-restore. The
  // openWidget click path also has its own paused-recovery as a
  // belt-and-suspenders fallback.
  useEffect(() => {
    if (mode !== "video") return
    if (typeof document === "undefined") return
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return
      const video = videoRef.current
      if (!video || !video.paused) return
      video.play().catch(() => {
        /* will be retried inside the next openWidget click */
      })
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange)
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
        const video = videoRef.current
        const canvas = canvasRef.current
        if (!video || !canvas) return

        // Black-box recovery on Android:
        //
        // After a PWA backgrounding cycle (user switches apps and
        // comes back), Chrome Android pauses muted videos for energy
        // reasons even though the page is "visible" again. The video
        // element keeps its HAVE_METADATA readyState and last frame
        // dimensions cached, so the wait loop below sails through —
        // but the underlying canvas-capture stream isn't actually
        // emitting frames. requestPictureInPicture then succeeds and
        // the OS opens the floater around a stale/empty frame, which
        // renders as a black box until the user refreshes the app.
        //
        // We also occasionally see the canvas track end ("readyState
        // === 'ended'") after long backgrounding on some Android
        // builds — at which point video.srcObject is bound to a dead
        // MediaStream and PiP definitely opens black.
        //
        // Recovery: inside the user-gesture window from this click,
        // (a) rebuild the stream when the existing track has died,
        // and (b) call play() so the video resumes emitting frames.
        // Both operations are gesture-friendly so we stay well within
        // transient activation. play() is a no-op when already
        // playing, so this is safe on the happy path too.
        const existingTrack = streamRef.current?.getVideoTracks()[0]
        const streamDead =
          !streamRef.current ||
          !existingTrack ||
          existingTrack.readyState !== "live"
        if (streamDead) {
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => {
              try {
                t.stop()
              } catch {
                /* best-effort */
              }
            })
          }
          drawCanvasWidget(canvas, widgetData, size, lastUpdate, now)
          const fresh = canvas.captureStream(0)
          streamRef.current = fresh
          video.srcObject = fresh
        }

        if (video.paused) {
          try {
            await video.play()
          } catch {
            /* fall through; we'll still try requestPictureInPicture */
          }
        }

        // The pre-warm useEffect keeps a live captureStream bound to
        // a playing video element from the moment we detected video-
        // PiP support. By the time the user clicks Pop-out, video is
        // typically already HAVE_METADATA (or better). Push a fresh
        // frame so the floater shows current data on its first paint.
        const track = streamRef.current?.getVideoTracks()[0] as
          | CanvasCaptureTrack
          | undefined
        if (track?.requestFrame) track.requestFrame()

        // Black-box fix: a fast click before pre-warm's play()
        // resolved would land on a video still in HAVE_NOTHING. The
        // OS PiP API would succeed on Chrome (Android included) but
        // the floater opened around an empty stream — black box. We
        // briefly wait for video to actually have dimensions AND be
        // unpaused before requesting PiP. 800ms ceiling stays well
        // within transient activation's ~5s window so the API call
        // still has permission. Loop is a no-op once pre-warm is done.
        const waitStart = Date.now()
        while (
          (video.readyState < 1 /* HAVE_METADATA */ ||
            video.videoWidth === 0 ||
            video.paused) &&
          Date.now() - waitStart < 800
        ) {
          if (track?.requestFrame) track.requestFrame()
          if (video.paused) {
            // play() in here is fire-and-forget; awaiting it inside
            // a tight loop would defeat the timeout. The next iter
            // checks video.paused again and breaks out once it flips.
            video.play().catch(() => {})
          }
          await new Promise((r) => setTimeout(r, 30))
        }

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
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("PiP open failed:", e)
    } finally {
      openInFlightRef.current = false
    }
  }, [
    // openWidget no longer reads widgetData / lastUpdate / now
    // directly — the canvas drawing happens in the pre-warm + redraw
    // effects, and the document-mode portal renders against fresh
    // values via React. Trimming these out of the deps keeps the
    // openWidget reference stable across SWR refreshes, so the
    // auto-reopen useEffect doesn't tear down + reattach the
    // window listener every 30 seconds (and risk missing a click
    // during the microtask gap between cleanup and reattach).
    mode,
    pipWindow,
    videoPipActive,
    size,
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
  }, [mode, pipWindow])

  const dismissBanner = useCallback(() => setBannerDismissed(true), [
    setBannerDismissed,
  ])

  // Auto-pop on minimize. Toggling the autopictureinpicture HTML
  // attribute on the (pre-warmed, playing) video element makes the
  // browser auto-enter PiP whenever the document goes hidden and
  // auto-exit when it comes back — exactly the "pop out when I
  // leave the app, dock back when I return" behaviour users expect
  // from the Auto checkbox. Implemented natively by Chrome 89+
  // (including Android Chrome), so we don't need to maintain a
  // visibilitychange listener that calls requestPictureInPicture
  // (which would fail anyway, the API needs transient activation).
  //
  // Gating on videoReady avoids handing the browser a HAVE_NOTHING
  // video — that would auto-pip into a black floater. We only set
  // the attribute once pre-warm's play() has actually started
  // emitting frames.
  //
  // Document-mode users (desktop Chrome/Edge) don't get this auto
  // behaviour — Document PiP has no equivalent attribute. They
  // still get manual Pop-out + the size selector.
  useEffect(() => {
    if (mode !== "video") return
    // Skip on Android — the attribute is honored inconsistently
    // across Chrome Android versions and when it does fire it often
    // pops a blank "Chrome logo" floater instead of our content.
    // Better to not promise a feature we can't deliver cleanly.
    if (isAndroid) return
    const video = videoRef.current
    if (!video) return
    if (autoReopen && videoReady) {
      video.setAttribute("autopictureinpicture", "")
    } else {
      video.removeAttribute("autopictureinpicture")
    }
  }, [mode, autoReopen, videoReady, isAndroid])

  // Fallback for browsers where the autopictureinpicture attribute is
  // ignored (notably Chrome Android in many versions): listen for the
  // page going hidden and try to enter PiP imperatively. This call
  // can fail when the browser strictly requires transient activation
  // (which is gone by the time visibilitychange fires) — but on
  // browsers that consider recent page engagement sufficient, it
  // succeeds and gives us the "pop out on minimize" UX even where
  // the attribute silently no-ops. Best-effort, swallows failures.
  useEffect(() => {
    if (mode !== "video" || !autoReopen || !videoReady) return
    // Same skip-on-Android: the call mostly fails there anyway and
    // when it succeeds it tends to open a blank/Chrome-chrome
    // floater. Cleaner to disable the path entirely on Android.
    if (isAndroid) return
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return
      if (document.visibilityState !== "hidden") return
      const video = videoRef.current
      if (!video) return
      // Don't double-trigger if the browser already entered PiP via
      // the autopictureinpicture attribute.
      if (document.pictureInPictureElement === video) return
      // Push a fresh frame so the floater opens with current data.
      const track = streamRef.current?.getVideoTracks()[0] as
        | CanvasCaptureTrack
        | undefined
      if (track?.requestFrame) track.requestFrame()
      try {
        const p = video.requestPictureInPicture?.()
        if (p) p.catch(() => {})
      } catch {
        /* expected to fail without activation on some browsers */
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [mode, autoReopen, videoReady, isAndroid])

  const value = useMemo<PipContextValue>(
    () => ({
      mode,
      supported,
      pipActive,
      isAndroid,
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
      isAndroid,
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
            // Visible-but-invisible: positioned on-screen but with
            // 1px size and effectively zero opacity. The off-screen
            // (-99999px) trick we used previously made some Chrome
            // Android versions skip auto-Picture-in-Picture because
            // the spec considers a video clipped from the layout
            // ineligible for the autopictureinpicture attribute.
            // Tucking it in the bottom-right corner with 1×1 / very
            // low opacity keeps it eligible without affecting layout
            // or being visible to users. The video element still
            // carries explicit width/height attrs (below) so the OS
            // sizes the PiP window from those, not from the 1×1 CSS.
            position: "fixed",
            right: 0,
            bottom: 0,
            width: 1,
            height: 1,
            opacity: 0.0001,
            pointerEvents: "none",
            overflow: "hidden",
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
    isAndroid,
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
      {/* Auto checkbox is hidden on Android. Chrome Android honors
          the autopictureinpicture attribute inconsistently across
          versions, and when it does fire it tends to open a blank
          floater showing just the browser chrome — promising a
          feature we can't deliver cleanly is worse than not
          offering it. Manual Pop-out still works on Android, and
          the floating PiP window persists if the user backgrounds
          the PWA after popping it out manually. */}
      {!isAndroid && (
        <label
          className={`${chipBase} cursor-pointer hover:text-foreground hover:border-border/80 transition-colors select-none`}
          title="Auto-pop the widget into a floating window when you minimize / leave the app, dock back when you return"
        >
          <input
            type="checkbox"
            checked={autoReopen}
            onChange={(e) => setAutoReopen(e.target.checked)}
            className="h-3 w-3 accent-primary"
          />
          Auto
        </label>
      )}
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
