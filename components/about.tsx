"use client"

import type { ReactNode } from "react"
import { CornerBox } from "./primitives"
import { paletteVar } from "./theme"

const FAQ: [string, ReactNode][] = [
  [
    "What is the CYPH/ZEC ratio?",
    "It's the market price of one CYPH share divided by the market price of one ZEC. It is a live price ratio, not the treasury ZEC-per-share backing. Treasury backing is shown separately as NAV/share and uses disclosed ZEC holdings, live ZEC price, and CYPH shares outstanding.",
  ],
  [
    "How often does it update?",
    "Live: CYPH polls every 30 seconds (regular hours, pre-market, after-hours, and Blue Ocean ATS overnight), ZEC every 60 seconds from Kraken with Yahoo / CoinPaprika / CoinGecko fallbacks. The page also force-refreshes whenever you bring the tab back to the foreground.",
  ],
  [
    "Where does the data come from?",
    "Yahoo Finance for CYPH (with a page-scrape + v8 chart fallback) and for the macro/equity ticker chips (SPX, NDX, DJI, MSTR, COIN, DXY, GOLD, VIX). Kraken for primary ZEC price data, with Yahoo / CoinPaprika / CoinGecko fallbacks. CoinMarketCap + CoinPaprika for the leaderboard / market caps. Cipherscan for shielded supply + per-pool history. zecstats.com for daily transaction counts. cypherpunk.com's transactions endpoint for the treasury history. Everything is cached at the edge for ~30s-6h depending on volatility.",
  ],
  [
    "Is my portfolio data shared?",
    "Never. Portfolio entries live in your browser's localStorage only — they never leave the device.",
  ],
  [
    "How do I send feedback or feature ideas?",
    <>
      Email{" "}
      <a
        href="mailto:thomas.zarebczan@gmail.com"
        className="font-bold hover:underline"
        style={{ color: paletteVar("cyph") }}
      >
        thomas.zarebczan@gmail.com
      </a>{" "}
      or message{" "}
      <a
        href="https://x.com/tomzarebczan"
        target="_blank"
        rel="noopener noreferrer"
        className="font-bold hover:underline"
        style={{ color: paletteVar("cyph") }}
      >
        @tomzarebczan
      </a>{" "}
      on X.
    </>,
  ],
]

export function About() {
  return (
    <div className="max-w-3xl mx-auto py-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-[0.2em]">ABOUT CYPHZEC</h1>
        <p
          className="text-[13px] mt-3 leading-relaxed max-w-2xl"
          style={{ color: paletteVar("text"), opacity: 0.85 }}
        >
          Live{" "}
          <span style={{ color: paletteVar("cyph") }}>$CYPH</span> stock
          price (Cypherpunk Technologies, NASDAQ) and{" "}
          <span style={{ color: paletteVar("zec") }}>$ZEC</span> price, plus
          the CYPH/ZEC ratio. Updates every 30–60 seconds — includes
          pre-market, after-hours, and overnight Blue Ocean ATS sessions.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          {
            t: "PRICE FEEDS",
            d: "Yahoo Finance + Kraken + CoinGecko, deduped via SWR. Refreshes every 30–60s — focus & visibility events force a revalidate.",
          },
          {
            t: "EXTENDED HRS",
            d: "Pre-market, after-hours, and overnight Blue Ocean ATS prints surfaced when available. The CYPH card flips state during each session.",
          },
          {
            t: "FREE + PRIVATE",
            d: "No accounts, no tracking. Portfolio + holdings stored in your browser only.",
          },
        ].map((c) => (
          <CornerBox key={c.t} color={paletteVar("cyph")}>
            <div
              className="text-[10px] tracking-[0.3em] font-bold"
              style={{ color: paletteVar("cyph") }}
            >
              {c.t}
            </div>
            <div
              className="text-[12px] mt-1.5 leading-relaxed"
              style={{ color: paletteVar("text"), opacity: 0.85 }}
            >
              {c.d}
            </div>
          </CornerBox>
        ))}
      </div>

      <div>
        <h2 className="text-base font-bold tracking-[0.2em] mb-3">FAQ</h2>
        <div className="flex flex-col gap-2">
          {FAQ.map(([q, a], i) => (
            <details
              key={i}
              className="group px-3 py-2 transition-colors hover:bg-emerald-950/20"
              style={{ border: `1px solid ${paletteVar("text")}33` }}
            >
              <summary
                className="cursor-pointer text-[13px] flex items-center gap-2 list-none"
                style={{ color: paletteVar("cyph") }}
              >
                <span className="text-[10px] group-open:rotate-90 transition-transform inline-block">
                  ►
                </span>
                {q}
              </summary>
              <p
                className="text-[12px] mt-2 pl-5 leading-relaxed"
                style={{ color: paletteVar("text"), opacity: 0.85 }}
              >
                {a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}
