"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { type ReactNode, useEffect, useState } from "react"
import { useSWRConfig } from "swr"
import { PipProvider } from "@/components/pip-widget"
import {
  BUTTON_BAR_DEFAULT_KEYS,
  sanitizeButtonBar,
  type ButtonBarKey,
  useCyphzecSettings,
} from "./use-cyphzec-settings"
import { CRT, Brand, Ticker } from "./primitives"
import { useTickerChips } from "./use-ticker-chips"
import { paletteVar } from "./theme"

// Page IDs map 1:1 to /<id> paths (with "home" -> /).
export type PageId = ButtonBarKey

const ROUTES: Record<PageId, string> = {
  home: "/",
  rank: "/stats",
  shielding: "/shielding",
  exchanges: "/exchanges",
  port: "/portfolio",
  est: "/estimator",
  trsy: "/holdings",
  whatif: "/what-if",
  about: "/about",
  more: "/more",
  settings: "/settings",
}

const TOP_NAV: { id: PageId; label: string }[] = [
  { id: "home", label: "DASHBOARD" },
  { id: "rank", label: "ZEC STATS" },
  { id: "shielding", label: "SHIELDING" },
  { id: "port", label: "PORTFOLIO" },
  { id: "est", label: "ESTIMATOR" },
  { id: "trsy", label: "TREASURY" },
  { id: "about", label: "ABOUT" },
  { id: "settings", label: "SETTINGS" },
]

// Bottom-tab items (mobile only — md+ hides these). Anything not on
// the top tabs (settings, estimator, etc.) falls under "MORE".
const BOTTOM_TAB_DETAILS: Record<ButtonBarKey, {
  label: string
  path: string
  icon: ReactNode
}> = {
  home: {
    label: "HOME",
    path: "/",
    icon: (
      <path
        d="M3 12 12 3l9 9M5 10v10h14V10"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  rank: {
    label: "STATS",
    path: "/stats",
    icon: (
      <path
        d="M3 17l4-4 4 4 8-8"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  shielding: {
    label: "SHLD",
    path: "/shielding",
    icon: (
      <path
        d="M12 3 5 5.5v5.2c0 4 2.8 7.5 7 8.8 4.2-1.3 7-4.8 7-8.8V5.5L12 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  exchanges: {
    label: "EXCH",
    path: "/exchanges",
    icon: (
      <>
        <rect
          x="4"
          y="5"
          width="16"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        />
        <path
          d="M8 9h8M8 13h8"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </>
    ),
  },
  port: {
    label: "PORT",
    path: "/portfolio",
    icon: (
      <path
        d="M3 7h18M3 12h18M3 17h18"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    ),
  },
  est: {
    label: "EST",
    path: "/estimator",
    icon: (
      <path
        d="M5 19V5h14M5 15l4-4 3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  trsy: {
    label: "TRSY",
    path: "/holdings",
    icon: (
      <>
        <rect
          x="4"
          y="6"
          width="16"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        />
        <circle cx={12} cy={12} r={2.5} stroke="currentColor" strokeWidth={2} />
      </>
    ),
  },
  whatif: {
    label: "WHAT",
    path: "/what-if",
    icon: (
      <path
        d="M7 7a5 5 0 1 1 6 4.9v2.1M12 18h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  about: {
    label: "ABOUT",
    path: "/about",
    icon: (
      <path
        d="M12 17v-6M12 7h.01M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  settings: {
    label: "SET",
    path: "/settings",
    icon: (
      <path
        d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    ),
  },
  more: {
    label: "MORE",
    path: "/more",
    icon: (
      <>
        <circle cx={5} cy={12} r={1.4} fill="currentColor" />
        <circle cx={12} cy={12} r={1.4} fill="currentColor" />
        <circle cx={19} cy={12} r={1.4} fill="currentColor" />
      </>
    ),
  },
}

// Map page IDs to the bottom-tab they should highlight.
function bottomTabFor(active: PageId, buttonBar: ButtonBarKey[]): ButtonBarKey {
  if (active === "home") return "home"
  if (buttonBar.includes(active)) return active
  if (
    (active === "exchanges" || active === "whatif") &&
    buttonBar.includes("rank")
  ) {
    return "rank"
  }
  return "more"
}

export function ETopNav({
  active,
  headerExtra,
}: {
  active: PageId
  /** Optional content rendered on the right side of the header on
   *  mobile (where the desktop nav is hidden). The dashboard slots
   *  its period selector in here so it shares a row with the brand
   *  instead of consuming a separate strip of vertical space. */
  headerExtra?: ReactNode
}) {
  return (
    <header
      className="flex items-center gap-2 md:gap-3 mb-3 py-1.5 px-2 border-y"
      style={{ borderColor: `${paletteVar("text")}33` }}
    >
      {/* Brand is a Link rather than a button so middle-click /
          cmd-click / open-in-new-tab all work. The Brand component
          itself is purely visual so it can sit inside any wrapper. */}
      <Link
        href={ROUTES.home}
        aria-label="CYPH ZEC home"
        className="inline-flex"
      >
        <Brand size={12} />
      </Link>
      {headerExtra && (
        <div className="md:hidden flex items-center min-w-0 ml-auto">
          {headerExtra}
        </div>
      )}
      <span
        aria-hidden="true"
        className="hidden md:inline"
        style={{ color: paletteVar("text"), opacity: 0.25 }}
      >
        │
      </span>
      <nav
        aria-label="Primary"
        className="hidden md:flex items-center gap-0.5 overflow-x-auto"
      >
        {TOP_NAV.map(({ id, label }) => {
          const on = active === id
          return (
            <Link
              key={id}
              href={ROUTES[id]}
              className="px-2 py-0.5 text-[11px] transition-colors whitespace-nowrap rounded"
              style={{
                color: on ? paletteVar("cyph") : paletteVar("text"),
                opacity: on ? 1 : 0.7,
                textShadow: on ? `0 0 6px ${paletteVar("cyph")}66` : "none",
              }}
            >
              {on ? `[${label}]` : label}
            </Link>
          )
        })}
      </nav>
      {headerExtra && (
        <div className="hidden md:flex items-center ml-auto">
          {headerExtra}
        </div>
      )}
    </header>
  )
}

export function BottomTabsE({
  active,
  buttonBar = BUTTON_BAR_DEFAULT_KEYS,
}: {
  active: PageId
  buttonBar?: ButtonBarKey[]
}) {
  const tabs = sanitizeButtonBar(buttonBar)
  const target = bottomTabFor(active, tabs)
  const [pendingTarget, setPendingTarget] = useState<ButtonBarKey | null>(null)
  const visualTarget = pendingTarget ?? target

  useEffect(() => {
    setPendingTarget(null)
  }, [target])

  return (
    <nav
      aria-label="Mobile"
      className="md:hidden fixed bottom-0 inset-x-0 grid z-20 select-none"
      style={{
        gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
        background: "rgba(0,0,0,0.95)",
        borderTop: `1px solid ${paletteVar("text")}44`,
        paddingBottom: "env(safe-area-inset-bottom, 8px)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {tabs.map((id) => {
        const it = BOTTOM_TAB_DETAILS[id]
        const on = visualTarget === id
        return (
          <Link
            key={id}
            href={it.path}
            prefetch
            aria-current={target === id ? "page" : undefined}
            onPointerDown={() => setPendingTarget(id)}
            onClick={() => setPendingTarget(id)}
            className="relative flex min-h-[50px] flex-col items-center justify-center gap-0.5 py-2 transition-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-3px]"
            style={{
              color: on ? paletteVar("cyph") : paletteVar("text"),
              opacity: on ? 1 : 0.55,
              outlineColor: paletteVar("cyph"),
              WebkitTapHighlightColor: "transparent",
              touchAction: "manipulation",
            }}
          >
            <svg
              className="block size-5 shrink-0"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              {it.icon}
            </svg>
            <span className="block h-[10px] font-mono text-[9px] leading-none tracking-[0.15em]">
              {it.label}
            </span>
            {on && (
              <span
                aria-hidden="true"
                className="absolute top-0 inset-x-1/3 h-[1px]"
                style={{
                  background: paletteVar("cyph"),
                  boxShadow: `0 0 6px ${paletteVar("cyph")}`,
                }}
              />
            )}
          </Link>
        )
      })}
    </nav>
  )
}

/** Root shell shared by every page. Renders the CRT overlay,
 *  top nav, and (mobile) bottom tabs. Mounting the shell also triggers
 *  the settings hook so the page is themed even before the user opens
 *  the Settings page in a session.
 *
 *  `headerExtra` is forwarded to ETopNav and renders alongside the
 *  brand. The dashboard uses it to host its period selector in the
 *  same row as the logo, saving a whole strip of vertical space on
 *  mobile. */
export function EShell({
  active,
  children,
  headerExtra,
}: {
  active: PageId
  children: ReactNode
  headerExtra?: ReactNode
}) {
  // Subscribe so settings get applied on mount + hot updates.
  const [settings] = useCyphzecSettings()
  const tickerChips = useTickerChips(settings)
  const router = useRouter()
  // Prefetch the most-likely-next pages so navigating from the
  // dashboard feels instant. (Next 16 prefetches Link on hover by
  // default, but the top-level routes are good candidates for an
  // upfront prefetch on dashboard mount.)
  useEffect(() => {
    if (active !== "home") return
    router.prefetch(ROUTES.rank)
    router.prefetch(ROUTES.shielding)
    router.prefetch(ROUTES.exchanges)
    router.prefetch(ROUTES.port)
    router.prefetch(ROUTES.est)
    router.prefetch(ROUTES.trsy)
  }, [active, router])

  // Mobile PWAs + iOS Safari frequently suppress the `focus` event
  // SWR uses for revalidateOnFocus when you switch tabs / apps. The
  // `visibilitychange` event fires reliably, so we listen for "visible"
  // and force-revalidate every cached key. Same pattern as the legacy
  // PriceDashboard so behaviour is consistent across surfaces.
  const { mutate: globalMutate } = useSWRConfig()
  useEffect(() => {
    if (typeof document === "undefined") return
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return
      globalMutate(() => true)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () =>
      document.removeEventListener("visibilitychange", onVisibility)
  }, [globalMutate])

  return (
    <PipProvider>
      <div
        className="cz-app min-h-screen relative"
        style={{
          background: "#000",
          color: paletteVar("text"),
          fontFamily:
            "ui-monospace, 'JetBrains Mono', Menlo, monospace",
        }}
      >
        <CRT />
        {/* Global ticker — rendered once at the top of every page
            so the macro/crypto strip stays visible as users navigate
            between routes. Settings-gated; renders nothing when the
            chip list is empty (no enabled chips, or no upstream data
            yet). */}
        {settings.ticker && tickerChips.length > 0 && (
          <div className="relative z-20">
            <Ticker chips={tickerChips} speed={settings.tickerSpeed} />
          </div>
        )}
        <div
          className="relative z-10 max-w-6xl mx-auto px-3 md:px-5 py-3 pb-24 md:pb-3"
          style={{ paddingTop: "max(12px, env(safe-area-inset-top, 12px))" }}
        >
          <ETopNav active={active} headerExtra={headerExtra} />
          {children}
        </div>
        <BottomTabsE active={active} buttonBar={settings.buttonBar} />
      </div>
    </PipProvider>
  )
}
