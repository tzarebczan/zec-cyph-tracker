"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { type ReactNode, useEffect } from "react"
import { useSWRConfig } from "swr"
import { PipProvider } from "@/components/pip-widget"
import { useCyphzecSettings } from "./use-cyphzec-settings"
import { CRT, Brand, LED, Ticker } from "./primitives"
import { useTickerChips } from "./use-ticker-chips"
import { paletteVar } from "./theme"

// Page IDs map 1:1 to /beta/<id> paths (with "home" -> /beta).
export type PageId =
  | "home"
  | "rank"
  | "port"
  | "est"
  | "trsy"
  | "about"
  | "more"
  | "settings"

const ROUTES: Record<PageId, string> = {
  home: "/beta",
  rank: "/beta/stats",
  port: "/beta/portfolio",
  est: "/beta/estimator",
  trsy: "/beta/holdings",
  about: "/beta/about",
  more: "/beta/more",
  settings: "/beta/settings",
}

const TOP_NAV: { id: PageId; label: string }[] = [
  { id: "home", label: "DASHBOARD" },
  { id: "rank", label: "ZEC STATS" },
  { id: "port", label: "PORTFOLIO" },
  { id: "est", label: "ESTIMATOR" },
  { id: "trsy", label: "TREASURY" },
  { id: "about", label: "ABOUT" },
  { id: "settings", label: "SETTINGS" },
]

// Bottom-tab items (mobile only — md+ hides these). Anything not on
// the top tabs (settings, estimator, etc.) falls under "MORE".
const BOTTOM_TABS: {
  id: PageId
  label: string
  path: string
  icon: ReactNode
}[] = [
  {
    id: "home",
    label: "HOME",
    path: "/beta",
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
  {
    id: "rank",
    label: "STATS",
    path: "/beta/stats",
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
  {
    id: "port",
    label: "PORT",
    path: "/beta/portfolio",
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
  {
    id: "more",
    label: "MORE",
    path: "/beta/more",
    icon: (
      <>
        <circle cx={5} cy={12} r={1.4} fill="currentColor" />
        <circle cx={12} cy={12} r={1.4} fill="currentColor" />
        <circle cx={19} cy={12} r={1.4} fill="currentColor" />
      </>
    ),
  },
]

// Map page IDs to the bottom-tab they should highlight.
function bottomTabFor(active: PageId): PageId {
  if (active === "home") return "home"
  if (active === "port") return "port"
  if (active === "rank") return "rank"
  return "more"
}

export function ETopNav({ active }: { active: PageId }) {
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
      <span
        aria-hidden="true"
        style={{ color: paletteVar("text"), opacity: 0.25 }}
      >
        │
      </span>
      <LED />
      <span className="text-[11px]" style={{ color: paletteVar("text") }}>
        LIVE
      </span>
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
    </header>
  )
}

export function BottomTabsE({ active }: { active: PageId }) {
  const target = bottomTabFor(active)
  return (
    <nav
      aria-label="Mobile"
      className="md:hidden fixed bottom-0 inset-x-0 grid grid-cols-4 z-20"
      style={{
        background: "rgba(0,0,0,0.95)",
        borderTop: `1px solid ${paletteVar("text")}44`,
        paddingBottom: "env(safe-area-inset-bottom, 8px)",
      }}
    >
      {BOTTOM_TABS.map((it) => {
        const on = target === it.id
        return (
          <Link
            key={it.id}
            href={it.path}
            aria-current={on ? "page" : undefined}
            className="relative flex flex-col items-center gap-0.5 py-2 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-3px]"
            style={{
              color: on ? paletteVar("cyph") : paletteVar("text"),
              opacity: on ? 1 : 0.55,
              outlineColor: paletteVar("cyph"),
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              {it.icon}
            </svg>
            <span className="font-mono text-[9px] tracking-[0.15em]">
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

/** Root shell shared by every /beta/* page. Renders the CRT overlay,
 *  top nav, and (mobile) bottom tabs. Mounting the shell also triggers
 *  the settings hook so the page is themed even before the user opens
 *  the Settings page in a session. */
export function EShell({
  active,
  children,
}: {
  active: PageId
  children: ReactNode
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
        {/* Global ticker — rendered once at the top of every /beta page
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
          <ETopNav active={active} />
          {children}
        </div>
        <BottomTabsE active={active} />
      </div>
    </PipProvider>
  )
}
