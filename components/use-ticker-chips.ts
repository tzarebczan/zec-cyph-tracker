"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { swrFetcher } from "./format"
import type { MarketsResponse, ZecStatsResponse, QuoteSnapshot, PricesResponse } from "./api-types"
import {
  type CyphzecSettings,
  type TickerChipKey,
} from "./use-cyphzec-settings"
import { paletteVar } from "./theme"
import type { TickerChip } from "./primitives"
import { pickLiveCyph } from "./quote-utils"

// Shape of the /api/ticker payload. Kept local because no other surface
// consumes it; if a second consumer appears we can lift to api-types.
interface TickerApiChip {
  key: string
  symbol: string
  value: string
  change: number | null
  sub?: string
}
interface TickerApiResponse {
  chips: TickerApiChip[]
  fetchedAt: number
  source: string
  stale?: boolean
}

// Indices / equities / macro chip keys — anything not in CHIP_TO_SYMBOL
// below is served by /api/ticker.
const NON_CRYPTO_KEYS = new Set<string>([
  "spx",
  "ndx",
  "dji",
  "mstr",
  "coin",
  "dxy",
  "gold",
  "vix",
])

// Map our chip keys to the symbol shown on the leaderboard. CMC + the
// CoinPaprika fallback both surface BTC/ETH/... in their `symbol`
// field, so a simple uppercase lookup is enough.
const CHIP_TO_SYMBOL: Partial<Record<TickerChipKey, string>> = {
  btc: "BTC",
  eth: "ETH",
  sol: "SOL",
  xrp: "XRP",
  ada: "ADA",
  avax: "AVAX",
  doge: "DOGE",
  hype: "HYPE",
  near: "NEAR",
}

// Build the live ticker chip list out of whatever data sources are
// currently available. Today that's:
//   • `/api/markets` for the top-coin price chips (BTC … DOGE).
//   • The dashboard subscription series for CYPH / ZEC / RATIO when
//     the user opts those in via Settings.
// Equity / index / macro chips (SPX, NDX, DJI, MSTR, COIN, DXY, GOLD,
// VIX) need a Yahoo-Finance aggregator endpoint we don't ship yet —
// those chip keys silently drop out of the rendered strip until the
// upstream lands. Toggling them in Settings still persists the
// preference so they light up the moment data arrives.
export function useTickerChips(settings: CyphzecSettings): TickerChip[] {
  const pageVisible = usePageVisible()
  const pollPaused = () => !pageVisible
  // Only fetch when the ticker is enabled — otherwise we'd keep
  // /api/markets warm on every page even for users who've turned the
  // tape off in Settings.
  const enabled = settings.ticker !== false
  const { data: markets } = useSWR<MarketsResponse>(
    enabled ? "/api/markets" : null,
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // The headline trio (CYPH / ZEC / RATIO) is opt-in via Settings,
  // but when on it should match the dashboard's live tick — so we
  // hit the same /api/quote + /api/prices?days=7 keys SWR already
  // dedupes for the dashboard subscription.
  const wantsHeadline =
    enabled &&
    (settings.tickerChips ?? []).some(
      (k) => (k as string) === "cyph" || (k as string) === "zec" || (k as string) === "ratio"
    )
  const { data: quote } = useSWR<QuoteSnapshot>(
    wantsHeadline ? "/api/quote" : null,
    swrFetcher,
    { refreshInterval: 30_000, keepPreviousData: true }
  )
  const { data: tick } = useSWR<PricesResponse>(
    wantsHeadline ? "/api/prices?days=7" : null,
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  // ZEC rank surfaces as an opt-in chip too. Same 5-min refresh cadence
  // as everywhere else in the app so SWR's cache picks up the existing
  // subscription rather than firing a new request.
  const wantsRank = enabled && (settings.tickerChips ?? []).some((k) => (k as string) === "rank")
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    wantsRank ? "/api/zec-stats" : null,
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  // Equity / index / macro chips — single batched fetch behind the
  // edge KV cache so the ticker doesn't drag the page on a cold load.
  // Only subscribes when the user actually has at least one
  // non-crypto chip enabled, so a user with only BTC/ETH chips
  // doesn't pay for the indices fetch.
  const wantsNonCrypto =
    enabled &&
    (settings.tickerChips ?? []).some((k) => NON_CRYPTO_KEYS.has(k as string))
  const { data: indices } = useSWR<TickerApiResponse>(
    wantsNonCrypto ? "/api/ticker" : null,
    swrFetcher,
    {
      // 60s aligns with the server-side KV TTL — no point asking
      // sooner than the cache can refresh.
      refreshInterval: 60_000,
      isPaused: pollPaused,
      keepPreviousData: true,
    }
  )

  return useMemo<TickerChip[]>(() => {
    if (!enabled) return []
    const chosen = settings.tickerChips ?? []
    const coins = markets?.coins ?? []
    const cyphPrice = pickLiveCyph(quote)
    const zecPrice = tick?.current?.zec?.price ?? null
    const ratio =
      cyphPrice != null && zecPrice != null && zecPrice > 0
        ? cyphPrice / zecPrice
        : null
    const out: TickerChip[] = []
    for (const k of chosen) {
      // Headline / context chips that don't come from /api/markets.
      // Cast to string because the headline keys aren't in the typed
      // chip-key union (they're opt-in extras the new design ships).
      const key = k as string
      if (key === "cyph") {
        if (cyphPrice != null) {
          out.push({
            key,
            symbol: "CYPH",
            value: "$" + cyphPrice.toFixed(2),
            change: tick?.stats?.cyph?.change24h ?? null,
            color: paletteVar("cyph"),
          })
        }
        continue
      }
      if (key === "zec") {
        if (zecPrice != null) {
          out.push({
            key,
            symbol: "ZEC",
            value: "$" + zecPrice.toFixed(2),
            change: tick?.stats?.zec?.change24h ?? null,
            color: paletteVar("zec"),
          })
        }
        continue
      }
      if (key === "ratio") {
        if (ratio != null) {
          out.push({
            key,
            symbol: "RATIO",
            value: ratio.toPrecision(4),
            change: tick?.stats?.ratio?.vsAvg7d ?? null,
            sub: "vs 7D",
            color: paletteVar("ratio"),
          })
        }
        continue
      }
      if (key === "rank") {
        if (zecStats?.rank != null) {
          out.push({
            key,
            symbol: "RANK",
            value: "#" + zecStats.rank,
            sub: "ZEC",
            color: paletteVar("zec"),
          })
        }
        continue
      }

      // Non-crypto chips — pulled from the batched /api/ticker payload.
      // We pass through the pre-formatted value + change as-is so chip
      // formatting (commas, decimals) stays in one place server-side.
      if (NON_CRYPTO_KEYS.has(key)) {
        const indexChip = indices?.chips.find((c) => c.key === key)
        if (indexChip == null) continue
        const chip: TickerChip = {
          key: indexChip.key,
          symbol: indexChip.symbol,
          value: indexChip.value,
          change: indexChip.change ?? null,
        }
        if (indexChip.sub) chip.sub = indexChip.sub
        out.push(chip)
        continue
      }

      // Top-coin chips — look up by symbol in the markets payload.
      const symbol = CHIP_TO_SYMBOL[k]
      if (symbol == null) continue
      const coin = coins.find((c) => c.symbol === symbol)
      if (!coin || coin.price == null) continue
      out.push({
        key: k,
        symbol,
        value:
          coin.price < 1
            ? "$" + coin.price.toFixed(4)
            : "$" +
              coin.price.toLocaleString("en-US", {
                maximumFractionDigits: 2,
              }),
        change: coin.change24h ?? null,
        // The BTC chip deep-links to the BTC-vs-ZEC page (the only
        // dedicated per-asset page we ship today).
        ...(symbol === "BTC" ? { href: "/bitcoin" } : {}),
      })
    }
    return out
  }, [enabled, settings.tickerChips, markets, quote, tick, zecStats, indices])
}
