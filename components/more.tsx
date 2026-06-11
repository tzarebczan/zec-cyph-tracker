"use client"

import Link from "next/link"
import { CornerBox } from "./primitives"
import { E_STATIC, paletteVar } from "./theme"
import { FEATURE_UPDATES, updateBadgeColor } from "./updates-data"
import { useFeatureUpdates } from "./use-feature-updates"

const ITEMS: {
  href: string
  t: string
  s: string
  c: () => string
  update?: boolean
  secondary?: {
    href: string
    label: string
    badge?: string
  }
}[] = [
  {
    href: "/updates",
    t: "FEATURES / UPDATES",
    s: "New tools, beta surfaces, release notes",
    c: () => paletteVar("cyph"),
    update: true,
  },
  {
    href: "/stats",
    t: "ZEC STATS",
    s: "Top-50 leaderboard - supply - shielded - tx",
    c: () => paletteVar("zec"),
  },
  {
    href: "/shielding",
    t: "SHIELDING DETAILS",
    s: "Post-NU6.2 in/out by block, hour, day",
    c: () => paletteVar("ratio"),
    secondary: {
      href: "/shielding/unshieldings",
      label: "UNSHIELDINGS",
      badge: "BETA",
    },
  },
  {
    href: "/orchard-risk",
    t: "ORCHARD RISK",
    s: "Polymarket signal for exploit confirmation odds",
    c: () => E_STATIC.red,
  },
  {
    href: "/exchanges",
    t: "EXCHANGES",
    s: "ZEC venue share - 24h volume flow",
    c: () => paletteVar("zec"),
  },
  {
    href: "/what-if",
    t: "WHAT IF",
    s: "If ZEC captures a fraction of each market",
    c: () => paletteVar("cyph"),
  },
  {
    href: "/portfolio",
    t: "PORTFOLIO",
    s: "Track CYPH + ZEC on-device",
    c: () => paletteVar("ratio"),
  },
  {
    href: "/estimator",
    t: "ESTIMATOR",
    s: "Predict CYPH for any $ZEC price",
    c: () => paletteVar("cyph"),
  },
  {
    href: "/holdings",
    t: "TREASURY",
    s: "Cypherpunk ZEC holdings - proof-of-reserves",
    c: () => paletteVar("amber"),
  },
  {
    href: "/about",
    t: "ABOUT",
    s: "How this site works - FAQ",
    c: () => paletteVar("text"),
  },
  {
    href: "/settings",
    t: "SETTINGS",
    s: "Theme, density, glow, motion",
    c: () => paletteVar("cyph"),
  },
]

export function More() {
  const latest = FEATURE_UPDATES[0] ?? null
  const { hasUnseenUpdates, markLatestSeen } = useFeatureUpdates()

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">MORE</h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          everything outside the dashboard
        </span>
      </div>

      {latest && hasUnseenUpdates && (
        <CornerBox color={updateBadgeColor(latest)}>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="text-[9px] font-bold tracking-[0.18em]"
                  style={{ color: updateBadgeColor(latest) }}
                >
                  NEW UPDATE
                </span>
                <span
                  className="border px-1.5 py-0.5 text-[8px] tracking-[0.16em]"
                  style={{ borderColor: `${updateBadgeColor(latest)}66` }}
                >
                  {latest.badge}
                </span>
              </div>
              <div
                className="mt-1 text-[13px] font-bold tracking-[0.12em]"
                style={{ color: paletteVar("text") }}
              >
                {latest.title}
              </div>
              <div
                className="mt-0.5 text-[11px]"
                style={{ color: paletteVar("text"), opacity: 0.65 }}
              >
                {latest.summary}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/updates"
                onClick={markLatestSeen}
                className="border px-2 py-1 text-[10px] tracking-[0.14em] hover:underline"
                style={{
                  color: updateBadgeColor(latest),
                  borderColor: `${updateBadgeColor(latest)}66`,
                }}
              >
                OPEN
              </Link>
              <button
                type="button"
                onClick={markLatestSeen}
                className="border px-2 py-1 text-[10px] tracking-[0.14em]"
                style={{
                  color: paletteVar("text"),
                  borderColor: `${paletteVar("text")}33`,
                  opacity: 0.7,
                }}
              >
                DISMISS
              </button>
            </div>
          </div>
        </CornerBox>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ITEMS.map((it) => {
          const color = it.c()
          const showUpdateBadge = it.update && hasUnseenUpdates
          if (it.secondary) {
            return (
              <div key={it.href} className="block">
                <CornerBox color={color}>
                  <Link
                    href={it.href}
                    className="flex items-center gap-3 hover:underline"
                    style={{ color }}
                  >
                    <span className="font-bold text-[13px] tracking-[0.2em]">
                      {it.t}
                    </span>
                    <span className="ml-auto">-&gt;</span>
                  </Link>
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: paletteVar("text"), opacity: 0.65 }}
                  >
                    {it.s}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Link
                      href={it.href}
                      className="border px-2 py-1 text-[9px] font-bold tracking-[0.14em] hover:underline"
                      style={{ color, borderColor: `${color}55` }}
                    >
                      OVERVIEW
                    </Link>
                    <Link
                      href={it.secondary.href}
                      className="border px-2 py-1 text-[9px] font-bold tracking-[0.14em] hover:underline"
                      style={{
                        color: E_STATIC.red,
                        borderColor: `${E_STATIC.red}66`,
                        boxShadow: `0 0 8px ${E_STATIC.red}18`,
                      }}
                    >
                      {it.secondary.label}
                      {it.secondary.badge ? ` ${it.secondary.badge}` : ""}
                    </Link>
                  </div>
                </CornerBox>
              </div>
            )
          }
          return (
            <Link
              key={it.href}
              href={it.href}
              onClick={it.update ? markLatestSeen : undefined}
              className="block"
            >
              <CornerBox color={color} interactive>
                <div className="flex items-center gap-3">
                  <span
                    className="font-bold text-[13px] tracking-[0.2em]"
                    style={{ color }}
                  >
                    {it.t}
                  </span>
                  {showUpdateBadge && (
                    <span
                      className="border px-1.5 py-0.5 text-[8px] font-bold tracking-[0.16em]"
                      style={{
                        color,
                        borderColor: `${color}66`,
                        boxShadow: `0 0 8px ${color}22`,
                      }}
                    >
                      NEW
                    </span>
                  )}
                  <span className="ml-auto" style={{ color }}>
                    -&gt;
                  </span>
                </div>
                <div
                  className="text-[11px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.65 }}
                >
                  {it.s}
                </div>
              </CornerBox>
            </Link>
          )
        })}
      </div>
    </>
  )
}
