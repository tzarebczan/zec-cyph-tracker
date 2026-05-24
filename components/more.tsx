"use client"

import Link from "next/link"
import { CornerBox } from "./primitives"
import { paletteVar } from "./theme"

const ITEMS: {
  href: string
  t: string
  s: string
  c: () => string
}[] = [
  {
    href: "/stats",
    t: "ZEC STATS",
    s: "Top-50 leaderboard · supply · shielded · tx",
    c: () => paletteVar("zec"),
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
    s: "Cypherpunk ZEC holdings · proof-of-reserves",
    c: () => paletteVar("amber"),
  },
  {
    href: "/about",
    t: "ABOUT",
    s: "How this site works · FAQ",
    c: () => paletteVar("text"),
  },
  {
    href: "/settings",
    t: "SETTINGS",
    s: "Theme, density, glow, motion",
    c: () => paletteVar("cyph"),
  },
]

export function BetaMore() {
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ITEMS.map((it) => {
          const color = it.c()
          return (
            <Link key={it.href} href={it.href} className="block">
              <CornerBox color={color} interactive>
                <div className="flex items-center gap-3">
                  <span
                    className="font-bold text-[13px] tracking-[0.2em]"
                    style={{ color }}
                  >
                    {it.t}
                  </span>
                  <span className="ml-auto" style={{ color }}>
                    →
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
