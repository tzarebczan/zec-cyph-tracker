import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  YAHOO_HEADERS,
  clearYahooSession,
  getYahooSession,
} from "@/lib/yahoo-session"

// Sell-side coverage for CYPH, from Yahoo's quoteSummary.
//
// Chosen over Benzinga / FMP / Finnhub because we already hold a Yahoo crumb
// session for quotes, so this adds no new vendor, key or bill — and
// upgradeDowngradeHistory carries exactly the fields the treasury page needs:
// firm, action, rating change, and both sides of a price-target move.
//
// One gotcha drove the shape below: financialData.targetMeanPrice lags badly.
// It read $0.90 for CYPH hours after Cantor Fitzgerald raised its target to
// $1.60, because Yahoo's consensus block refreshes on its own schedule. So the
// headline target is derived from the newest history entry that actually
// carries one, and the consensus figures are returned alongside, clearly
// separate, rather than being treated as current.

const SYMBOL = "CYPH"
// Ratings move a couple of times a quarter, and the crumb handshake is the
// flakiest link in the chain (Yahoo 429s it from some Node/Worker egress
// paths). So a successful fetch is mirrored to KV without a TTL and served
// whenever the live call fails — a throttle should never blank the panel.
const CACHE_KEY = "cyph.analysts.v1"
const STALE_KEY = "cyph.analysts.stale.v1"
const CACHE_TTL_SECONDS = 900
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=900, stale-while-revalidate=3600",
}

interface RawHistoryEntry {
  epochGradeDate?: number
  firm?: string
  toGrade?: string
  fromGrade?: string
  action?: string
  priceTargetAction?: string
  currentPriceTarget?: number
  priorPriceTarget?: number
}

interface RawQuoteSummary {
  quoteSummary?: {
    result?: Array<{
      upgradeDowngradeHistory?: { history?: RawHistoryEntry[] }
      financialData?: {
        targetMeanPrice?: { raw?: number }
        targetHighPrice?: { raw?: number }
        targetLowPrice?: { raw?: number }
        numberOfAnalystOpinions?: { raw?: number }
        currentPrice?: { raw?: number }
      }
      recommendationTrend?: {
        trend?: Array<{
          period?: string
          strongBuy?: number
          buy?: number
          hold?: number
          sell?: number
          strongSell?: number
        }>
      }
    }>
    error?: unknown
  }
}

/** Yahoo's `action` codes, spelled out. */
export type AnalystAction = "upgrade" | "downgrade" | "initiate" | "maintain" | "reiterate"

export interface AnalystRating {
  /** ms epoch. */
  date: number
  firm: string
  action: AnalystAction
  fromGrade: string | null
  toGrade: string | null
  priceTarget: number | null
  priorPriceTarget: number | null
  /** Signed % change in the price target, when both sides are known. */
  priceTargetChangePct: number | null
  /** True when the target moved but the rating did not — the common case, and
   *  the distinction between "raised its target" and "upgraded the stock". */
  targetOnlyMove: boolean
}

export interface CyphAnalystsResponse {
  ratings: AnalystRating[]
  latest: AnalystRating | null
  /** Distinct covering firms seen in the history. */
  firmCount: number
  /** Newest target from the rating history — fresher than Yahoo's consensus. */
  latestPriceTarget: number | null
  consensus: {
    targetMean: number | null
    targetHigh: number | null
    targetLow: number | null
    analystCount: number | null
    strongBuy: number | null
    buy: number | null
    hold: number | null
    sell: number | null
    strongSell: number | null
  }
  fetchedAt: number
  stale?: boolean
  message?: string
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>
}

async function getKv(): Promise<KVLike | null> {
  try {
    const context = await getCloudflareContext({ async: true })
    return (
      (context?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ??
      null
    )
  } catch {
    return null
  }
}

async function readCache(
  kv: KVLike | null,
  key: string
): Promise<CyphAnalystsResponse | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CyphAnalystsResponse
    return Array.isArray(parsed?.ratings) ? parsed : null
  } catch {
    return null
  }
}

async function writeCache(kv: KVLike | null, payload: CyphAnalystsResponse) {
  if (!kv) return
  const json = JSON.stringify(payload)
  await Promise.all([
    kv.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS }),
    kv.put(STALE_KEY, json),
  ]).catch(() => {})
}

function mapAction(raw: string | undefined): AnalystAction {
  switch ((raw ?? "").toLowerCase()) {
    case "up":
      return "upgrade"
    case "down":
      return "downgrade"
    case "init":
      return "initiate"
    case "reit":
      return "reiterate"
    default:
      return "maintain"
  }
}

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

function normalizeHistory(raw: RawHistoryEntry[]): AnalystRating[] {
  return raw
    .map((entry) => {
      const target = positive(entry.currentPriceTarget)
      const prior = positive(entry.priorPriceTarget)
      const from = entry.fromGrade?.trim() || null
      const to = entry.toGrade?.trim() || null
      const action = mapAction(entry.action)
      return {
        date: (entry.epochGradeDate ?? 0) * 1000,
        firm: entry.firm?.trim() || "—",
        action,
        fromGrade: from,
        toGrade: to,
        priceTarget: target,
        priorPriceTarget: prior,
        priceTargetChangePct:
          target != null && prior != null ? ((target - prior) / prior) * 100 : null,
        targetOnlyMove:
          target != null &&
          prior != null &&
          target !== prior &&
          action !== "upgrade" &&
          action !== "downgrade",
      }
    })
    .filter((r) => r.date > 0)
    .sort((a, b) => b.date - a.date)
}

async function fetchSummary(): Promise<RawQuoteSummary> {
  const modules = "upgradeDowngradeHistory,financialData,recommendationTrend"
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getYahooSession(attempt > 0)
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${SYMBOL}` +
      `?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`
    const res = await fetch(url, {
      headers: { ...YAHOO_HEADERS, Cookie: session.cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) {
      clearYahooSession()
      lastErr = new Error(`Yahoo quoteSummary auth rejected: ${res.status}`)
      continue
    }
    if (!res.ok) throw new Error(`Yahoo quoteSummary failed: ${res.status}`)
    return (await res.json()) as RawQuoteSummary
  }
  throw lastErr instanceof Error ? lastErr : new Error("quoteSummary failed")
}

export async function GET() {
  const fetchedAt = Date.now()
  const kv = await getKv()
  const fresh = await readCache(kv, CACHE_KEY)
  if (fresh) return NextResponse.json(fresh, { headers: RESPONSE_HEADERS })

  try {
    const json = await fetchSummary()
    const result = json.quoteSummary?.result?.[0]
    if (!result) throw new Error("Yahoo returned no quoteSummary result")

    const ratings = normalizeHistory(
      result.upgradeDowngradeHistory?.history ?? []
    )
    const trend = result.recommendationTrend?.trend?.[0] ?? {}
    const fin = result.financialData ?? {}

    const payload: CyphAnalystsResponse = {
      ratings,
      latest: ratings[0] ?? null,
      firmCount: new Set(ratings.map((r) => r.firm)).size,
      latestPriceTarget:
        ratings.find((r) => r.priceTarget != null)?.priceTarget ?? null,
      consensus: {
        targetMean: positive(fin.targetMeanPrice?.raw),
        targetHigh: positive(fin.targetHighPrice?.raw),
        targetLow: positive(fin.targetLowPrice?.raw),
        analystCount: positive(fin.numberOfAnalystOpinions?.raw),
        strongBuy: trend.strongBuy ?? null,
        buy: trend.buy ?? null,
        hold: trend.hold ?? null,
        sell: trend.sell ?? null,
        strongSell: trend.strongSell ?? null,
      },
      fetchedAt,
    }
    await writeCache(kv, payload)
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  } catch (err) {
    // Serve the last good snapshot rather than an empty panel — a throttled
    // crumb handshake says nothing about whether the ratings changed.
    const stale = await readCache(kv, STALE_KEY)
    if (stale) {
      return NextResponse.json(
        {
          ...stale,
          stale: true,
          message: err instanceof Error ? err.message : "analyst fetch failed",
        },
        { headers: RESPONSE_HEADERS }
      )
    }
    return NextResponse.json(
      {
        ratings: [],
        latest: null,
        firmCount: 0,
        latestPriceTarget: null,
        consensus: {
          targetMean: null,
          targetHigh: null,
          targetLow: null,
          analystCount: null,
          strongBuy: null,
          buy: null,
          hold: null,
          sell: null,
          strongSell: null,
        },
        fetchedAt,
        stale: true,
        message: err instanceof Error ? err.message : "analyst fetch failed",
      } satisfies CyphAnalystsResponse,
      { headers: RESPONSE_HEADERS }
    )
  }
}
