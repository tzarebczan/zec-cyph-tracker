"use client"

import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { compareQuoteSnapshot, swrFetcher } from "./format"
import { useMarketSession } from "./market-clock"
import { offHoursPrint } from "./quote-utils"
import type {
  CyphSolanaBook,
  CyphSolanaDepthResponse,
  QuoteSnapshot,
} from "./api-types"

// Hooks for the Solana CYPH book, kept apart from the panel that draws it so
// the dashboard tile's strip can reach them without importing the panel — and
// so `cyph-depth.tsx`, which owns the renderers the panel borrows, can use
// them without the two files importing each other.

/** The pools move continuously, but the probe behind this is fifteen routed
 *  quotes; a minute-old curve still answers the question it is asked. */
const POLL_MS = 60_000

/** `enabled` is false wherever the book would not be drawn — during a US
 *  session, mainly. Each poll costs fifteen routed quotes upstream, so the
 *  key is nulled rather than merely ignored: a dashboard left open through a
 *  trading day should not be probing Solana pools for a strip that is showing
 *  the Nasdaq book. */
export function useCyphSolanaDepth(enabled = true) {
  const visible = usePageVisible()
  return useSWR<CyphSolanaDepthResponse>(
    enabled ? "/api/cyph-solana-depth" : null,
    swrFetcher,
    {
    refreshInterval: visible ? POLL_MS : 0,
    keepPreviousData: true,
    // A 503 here means the pools could not be probed, which is a normal
    // transient. Surfaces fall back to the equity book rather than retrying
    // hard against an upstream that is already struggling.
    shouldRetryOnError: false,
    }
  )
}

/** True when the 24x7 market is the one the app is currently quoting.
 *
 *  This is deliberately the *same* predicate the headline price uses rather
 *  than a second reading of the calendar. The two differ in one real case:
 *  the overnight session counts as open from 20:00 ET, but Blue Ocean does
 *  not print CYPH, so `offHoursPrint` keeps the token price until a print
 *  from that window lands. Gating depth on a plain "is the market closed"
 *  would put a two-day-old Nasdaq book under a live Solana price on the same
 *  tile for those hours — the precise mismatch the 24x7 price was added to
 *  remove. One predicate, so the badge and the book cannot disagree.
 *
 *  `useMarketSession()` is what makes it re-render: the answer changes at
 *  20:00 ET on a Friday with no new payload behind it. It also reports null
 *  on the server and on the first client render, and gating on that keeps the
 *  markup identical on both sides of hydration. */
export function useTokenMarketIsLive(): boolean {
  const schedule = useMarketSession()
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    compare: compareQuoteSnapshot,
    keepPreviousData: true,
  })
  return schedule != null && offHoursPrint(quote) != null
}

/** The Solana book, but only while it is the market the app is quoting. */
export function useSolanaBookWhenClosed(): CyphSolanaBook | null {
  const live = useTokenMarketIsLive()
  const { data } = useCyphSolanaDepth(live)
  if (!live) return null
  return data?.book ?? null
}
