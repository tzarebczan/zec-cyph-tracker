"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import useSWR from "swr"
import {
  ExternalLink,
  PictureInPicture2,
  X,
  Sun,
  Moon,
  Clock,
} from "lucide-react"
import { usePersistentState } from "@/lib/use-persistent-state"

// Document Picture-in-Picture widget for CYPH / ZEC at-a-glance stats.
// Uses the Document PiP API (https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)
// rather than the older HTMLVideoElement PiP, which can only render a
// video stream. Document PiP gives us a real always-on-top browser
// window we can render arbitrary React into.
//
// Compatibility:
//   - Chrome desktop 116+, Edge 116+ ✓
//   - Chrome Android 126+ ✓
//   - Firefox / Safari: unsupported, we hide the button entirely.
//
// User gesture: the open() call must happen inside a user-initiated
// event handler (click / keypress). The auto-open preference can't
// fire on page load; instead we attach a one-shot click listener and
// open the widget on the user's first interaction with the page.

type WidgetSize = "mini" | "compact" | "full"

const SIZES: Record<
  WidgetSize,
  { w: number; h: number; label: string; description: string }
> = {
  mini: {
    w: 240,
    h: 120,
    label: "Mini",
    description: "Two prices",
  },
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
}

interface QuoteData {
  marketState?: string
  regularMarketPrice?: number | null
  preMarketPrice?: number | null
  postMarketPrice?: number | null
  overnightMarketPrice?: number | null
  preMarketTime?: number | null
  postMarketTime?: number | null
  overnightMarketTime?: number | null
  regularMarketChangePercent?: number | null
}

interface PriceData {
  current?: {
    cyph?: { price?: number | null; change24h?: number | null }
    zec?: { price?: number | null; change24h?: number | null }
  }
  history?: { ratio: number | null }[]
  stats?: {
    cyph?: {
      change7d?: number | null
      change30d?: number | null
    }
    zec?: {
      change7d?: number | null
      change30d?: number | null
    }
  }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"

export function PipWidget() {
  // SSR-safe support detection — `documentPictureInPicture` doesn't
  // exist on Window's typing on the server. We don't want the button
  // to flicker in then out, so we render nothing until mounted, then
  // either the controls or null based on real support.
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => {
    setSupported(
      typeof window !== "undefined" && "documentPictureInPicture" in window
    )
  }, [])

  const [pipWindow, setPipWindow] = useState<Window | null>(null)
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
  const openInFlightRef = useRef(false)

  const openWidget = useCallback(async () => {
    if (
      typeof window === "undefined" ||
      !window.documentPictureInPicture ||
      pipWindow ||
      openInFlightRef.current
    ) {
      return
    }
    openInFlightRef.current = true
    try {
      const pip = await window.documentPictureInPicture.requestWindow({
        width: SIZES[size].w,
        height: SIZES[size].h,
      })

      // Mirror page styles into the PiP doc. The standard MDN pattern:
      // try inlining each stylesheet's rules; if CORS blocks the read
      // (e.g. fonts.googleapis.com), fall back to a <link rel> with
      // the same href so the PiP doc fetches it directly.
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

      // Give the body the same dark background the main app uses, so
      // there's no white flash before our React content paints.
      pip.document.body.style.margin = "0"
      pip.document.body.style.background = "#0b0f14"
      pip.document.body.style.color = "#f5f5f5"
      pip.document.body.style.fontFamily =
        "ui-monospace, SFMono-Regular, Menlo, monospace"
      pip.document.title = "$CYPH / $ZEC"

      pip.addEventListener("pagehide", () => {
        setPipWindow(null)
      })

      setPipWindow(pip)
    } catch (e) {
      console.error("PiP open failed:", e)
    } finally {
      openInFlightRef.current = false
    }
  }, [pipWindow, size])

  const closeWidget = useCallback(() => {
    pipWindow?.close()
    setPipWindow(null)
  }, [pipWindow])

  // Auto-reopen: Document PiP requires a user gesture, so we can't
  // open on mount. Instead, attach a one-shot click/keydown listener
  // that fires on the next user interaction.
  useEffect(() => {
    if (!autoReopen || !supported || pipWindow) return
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
  }, [autoReopen, supported, pipWindow, openWidget])

  // Hide entirely until we've confirmed support; this also hides on
  // Firefox / Safari which don't implement Document PiP.
  if (supported !== true) return null

  return (
    <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
      {pipWindow ? (
        <button
          onClick={closeWidget}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border hover:text-foreground hover:border-border/80 transition-colors"
          title="Close the picture-in-picture widget"
        >
          <X className="h-3 w-3" />
          Close widget
        </button>
      ) : (
        <button
          onClick={openWidget}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border hover:text-foreground hover:border-border/80 transition-colors"
          title="Open a small always-on-top window with live prices"
        >
          <PictureInPicture2 className="h-3 w-3" />
          Pop-out widget
        </button>
      )}
      {!pipWindow && (
        <select
          value={size}
          onChange={(e) => setSize(e.target.value as WidgetSize)}
          className="bg-secondary text-foreground rounded border border-border px-1 py-0.5 text-[10px] font-mono"
          title="Widget size"
          aria-label="Widget size"
        >
          {(Object.entries(SIZES) as [WidgetSize, (typeof SIZES)[WidgetSize]][]).map(
            ([id, info]) => (
              <option key={id} value={id}>
                {info.label}
              </option>
            )
          )}
        </select>
      )}
      <label
        className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors select-none"
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
      {pipWindow &&
        createPortal(
          <PipContent size={size} />,
          pipWindow.document.body
        )}
    </div>
  )
}

function fmtPrice(p: number | null | undefined) {
  if (p == null) return "—"
  return p < 1
    ? `$${p.toFixed(4)}`
    : `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(p: number | null | undefined) {
  if (p == null) return "—"
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`
}

function fmtRatio(r: number | null) {
  if (r == null) return "—"
  return r < 0.001 ? r.toExponential(3) : r.toPrecision(4)
}

function pickLiveCyph(q: QuoteData | undefined): {
  price: number | null
  state: string | null
  isExt: boolean
} {
  if (!q) return { price: null, state: null, isExt: false }
  if (q.marketState === "REGULAR") {
    return { price: q.regularMarketPrice ?? null, state: "REGULAR", isExt: false }
  }
  // Pick the freshest extended-hours print.
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

function PipContent({ size }: { size: WidgetSize }) {
  const { data: prices } = useSWR<PriceData>(
    "/api/prices?days=7",
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const { data: quote } = useSWR<QuoteData>("/api/quote", fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })

  const cyphLive = pickLiveCyph(quote)
  const cyph = cyphLive.price ?? prices?.current?.cyph?.price ?? null
  const zec = prices?.current?.zec?.price ?? null
  const cyphCh = prices?.current?.cyph?.change24h ?? null
  const zecCh = prices?.current?.zec?.change24h ?? null
  const ratio = cyph != null && zec != null && zec > 0 ? cyph / zec : null

  // Compact + Full also use 7D/30D perf from the prices stats block.
  const cyph7d = prices?.stats?.cyph?.change7d ?? null
  const cyph30d = prices?.stats?.cyph?.change30d ?? null
  const zec7d = prices?.stats?.zec?.change7d ?? null
  const zec30d = prices?.stats?.zec?.change30d ?? null

  const showRatio = size !== "mini"
  const show24h = size !== "mini"
  const showState = size === "full"
  const showPerfChips = size === "full"

  return (
    <div
      className="flex flex-col gap-2 p-3 h-screen w-screen"
      style={{ background: "#0b0f14", color: "#f5f5f5" }}
    >
      {/* Top row: tiny ticker bar + market-state badge on Full */}
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span aria-hidden="true" className="inline-flex items-center gap-1">
          <span style={{ color: CYPH_COLOR }}>$CYPH</span>
          <span className="opacity-60">/</span>
          <span style={{ color: ZEC_COLOR }}>$ZEC</span>
        </span>
        {showState && cyphLive.state && (
          <StateBadge state={cyphLive.state} isExt={cyphLive.isExt} />
        )}
      </div>

      {/* Two-column price layout: CYPH on left, ZEC on right. Bigger
          font on the bigger sizes. */}
      <div className="flex items-stretch gap-3 flex-1 min-h-0">
        <PriceCol
          label="$CYPH"
          color={CYPH_COLOR}
          price={cyph}
          change24h={show24h ? cyphCh : null}
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
          price={zec}
          change24h={show24h ? zecCh : null}
          size={size}
        />
      </div>

      {/* Mid row: ratio (compact + full) */}
      {showRatio && (
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted-foreground">Ratio</span>
          <span className="font-mono font-bold" style={{ color: "#38bdf8" }}>
            {fmtRatio(ratio)}
          </span>
        </div>
      )}

      {/* Bottom row: perf chips on Full */}
      {showPerfChips && (
        <div className="flex flex-col gap-1 text-[10px]">
          <PerfRow
            label="$CYPH"
            color={CYPH_COLOR}
            d7={cyph7d}
            d30={cyph30d}
          />
          <PerfRow label="$ZEC" color={ZEC_COLOR} d7={zec7d} d30={zec30d} />
        </div>
      )}
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
  // Price font scales by widget size.
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
          style={{ color: isUp ? "#34d399" : "#f87171" }}
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
  if (pct == null)
    return <span className="opacity-60">{label} —</span>
  const isUp = pct >= 0
  return (
    <span style={{ color: isUp ? "#34d399" : "#f87171" }}>
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
    ? "#9ca3af"
    : isRegular
      ? "#34d399"
      : isExt
        ? "#a78bfa"
        : "#9ca3af"
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
