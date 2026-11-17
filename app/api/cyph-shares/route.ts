import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { putMirror } from "@/lib/kv-mirror"
import { SHARES_OVERRIDE } from "@/lib/manual-overrides"

// CYPH common shares outstanding, straight from SEC EDGAR.
//
// Yahoo's `sharesOutstanding` lags filings by a quarter — it kept showing the
// Q2 10-Q's 107.76M after the Q3 10-Q reported 149,041,593 — so the NAV math
// reads the cover-page figure (dei:EntityCommonStockSharesOutstanding) from
// the XBRL API instead. Free, keyless; SEC only asks for a descriptive UA.

const CIK = "0001509745"
const EDGAR_URL = `https://data.sec.gov/api/xbrl/companyconcept/CIK${CIK}/dei/EntityCommonStockSharesOutstanding.json`
const HEADERS = {
  "User-Agent": "cyphzec.com share-count refresh (admin@cyphzec.com)",
  Accept: "application/json",
}
const CACHE_KEY = "cyph.shares.v1"
const STALE_KEY = "cyph.shares.stale.v1"
const CACHE_TTL_SECONDS = 6 * 3600
const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
}

export interface CyphSharesResponse {
  /** Common shares outstanding, or null if nothing could be read. */
  shares: number | null
  /** YYYY-MM-DD the count is as of (cover-page date). */
  asOf: string | null
  filed: string | null
  form: string | null
  accession: string | null
  source: "edgar" | "manual-override" | "none"
  fetchedAt: number
  stale?: boolean
  message?: string
}

interface Fact {
  end: string
  val: number
  accn?: string
  form?: string
  filed?: string
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>
}

async function getKv(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    return (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
  } catch {
    return null
  }
}

async function readCache(kv: KVLike | null, key: string): Promise<CyphSharesResponse | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key)
    return raw ? (JSON.parse(raw) as CyphSharesResponse) : null
  } catch {
    return null
  }
}

/** Newest cover-page count by as-of date, then filing date (10-Q/A restates). */
function latestFact(facts: Fact[]): Fact | null {
  const valid = facts.filter(
    (f) => f && Number.isFinite(f.val) && f.val > 0 && Number.isFinite(Date.parse(f.end))
  )
  valid.sort(
    (a, b) =>
      Date.parse(b.end) - Date.parse(a.end) ||
      (Date.parse(b.filed ?? "") || 0) - (Date.parse(a.filed ?? "") || 0)
  )
  return valid[0] ?? null
}

/** The override wins only until EDGAR reports a count as-of a later date. */
function applyOverride(edgar: CyphSharesResponse): CyphSharesResponse {
  if (
    SHARES_OVERRIDE &&
    (!edgar.asOf || Date.parse(SHARES_OVERRIDE.asOf) > Date.parse(edgar.asOf))
  ) {
    return {
      ...edgar,
      shares: SHARES_OVERRIDE.value,
      asOf: SHARES_OVERRIDE.asOf,
      source: "manual-override",
    }
  }
  return edgar
}

export async function GET() {
  const fetchedAt = Date.now()
  const kv = await getKv()
  const fresh = await readCache(kv, CACHE_KEY)
  if (fresh) return NextResponse.json(applyOverride(fresh), { headers: RESPONSE_HEADERS })

  try {
    const res = await fetch(EDGAR_URL, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`EDGAR companyconcept failed: ${res.status}`)
    const json = (await res.json()) as { units?: { shares?: Fact[] } }
    const fact = latestFact(json.units?.shares ?? [])
    if (!fact) throw new Error("EDGAR returned no share-count facts")

    const payload: CyphSharesResponse = {
      shares: fact.val,
      asOf: fact.end,
      filed: fact.filed ?? null,
      form: fact.form ?? null,
      accession: fact.accn ?? null,
      source: "edgar",
      fetchedAt,
    }
    if (kv) {
      const body = JSON.stringify(payload)
      await Promise.all([
        kv.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS }),
        putMirror(kv, STALE_KEY, body),
      ]).catch(() => {})
    }
    return NextResponse.json(applyOverride(payload), { headers: RESPONSE_HEADERS })
  } catch (err) {
    const message = err instanceof Error ? err.message : "share count fetch failed"
    const stale = await readCache(kv, STALE_KEY)
    const base: CyphSharesResponse = stale ?? {
      shares: null,
      asOf: null,
      filed: null,
      form: null,
      accession: null,
      source: "none",
      fetchedAt,
    }
    return NextResponse.json(applyOverride({ ...base, stale: true, message }), {
      headers: RESPONSE_HEADERS,
    })
  }
}
