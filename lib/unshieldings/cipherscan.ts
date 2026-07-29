/**
 * Cipherscan API client for the unshielding monitor.
 */

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; cyphzec-unshielding-monitor/1.0; +https://cyphzec.com)",
  Accept: "application/json",
}

export type PoolMode = "ironwood" | "orchard" | "sapling" | "all"

export interface CipherscanFlow {
  id?: number
  txid?: string
  blockHeight?: number
  blockTime?: number
  flowType?: string
  amountZec?: number
  pool?: string
  addresses?: string[]
}

export interface CipherscanListResponse {
  success?: boolean
  flows?: CipherscanFlow[]
  pagination?: {
    total?: number
    totalPages?: number
    limit?: number
    hasNext?: boolean
    nextCursor?: number
    nextCursorId?: number
  }
}

export interface CipherscanFlowPoint {
  date?: string
  deshield?: number
  deshieldTx?: number
}

export interface CipherscanFlowsResponse {
  success?: boolean
  points?: CipherscanFlowPoint[]
}

export interface CipherscanTxOutput {
  address?: string | null
  value?: string | number | null
  spent?: boolean
}

export interface CipherscanTxDetail {
  outputs?: CipherscanTxOutput[]
}

export interface CipherscanAddressTx {
  txid?: string
  blockHeight?: number
  blockTime?: string | number
  hasSapling?: boolean
  hasOrchard?: boolean
  hasIronwood?: boolean
  hasSprout?: boolean
  inputValue?: number
  netChange?: number
}

export interface CipherscanAddressResponse {
  balance?: number
  totalReceived?: number
  totalSent?: number
  txCount?: number
  lastSeen?: string | number
  transactions?: CipherscanAddressTx[]
}

export function listUrl(
  pool: PoolMode,
  limit: number,
  cursor: number | null,
  cursorId: number | null
): URL {
  const url = new URL(`${CIPHERSCAN}/shielded/list`)
  url.searchParams.set("flow_type", "deshield")
  url.searchParams.set("limit", String(limit))
  if (pool !== "all") url.searchParams.set("pool", pool)
  if (cursor != null) url.searchParams.set("cursor", String(cursor))
  if (cursorId != null) url.searchParams.set("cursorId", String(cursorId))
  return url
}

export function flowsUrl(pool: PoolMode): URL {
  const url = new URL(`${CIPHERSCAN}/pools/flows`)
  url.searchParams.set("period", "90d")
  url.searchParams.set("granularity", "hourly")
  if (pool !== "all") url.searchParams.set("pool", pool)
  return url
}

export function txDetailUrl(hash: string): URL {
  return new URL(`${CIPHERSCAN}/tx/${hash}`)
}

export function addressDetailUrl(address: string): URL {
  const url = new URL(`${CIPHERSCAN}/address/${address}`)
  url.searchParams.set("limit", "50")
  return url
}

export async function fetchJson<T>(url: URL | string): Promise<T> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`CipherScan ${res.status} for ${String(url)}`)
  return (await res.json()) as T
}

/** A tiny token-bucket rate limiter. */
export class RateLimiter {
  private tokens: number
  private lastRefill: number
  constructor(
    private maxTokens: number,
    private refillMs: number
  ) {
    this.tokens = maxTokens
    this.lastRefill = Date.now()
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now()
      const elapsed = now - this.lastRefill
      if (elapsed >= this.refillMs) {
        this.tokens = this.maxTokens
        this.lastRefill = now
      }
      if (this.tokens > 0) {
        this.tokens -= 1
        return
      }
      await new Promise((r) => setTimeout(r, Math.max(10, this.refillMs - elapsed)))
    }
  }
}

/** Fetch many URLs concurrently while respecting a rate limit. */
export async function fetchMany<T>(
  urls: (URL | string)[],
  concurrency: number,
  limiter: RateLimiter
): Promise<(T | Error)[]> {
  const results = new Array<T | Error>(urls.length)
  let next = 0
  async function run() {
    while (next < urls.length) {
      const index = next
      next += 1
      await limiter.acquire()
      try {
        results[index] = await fetchJson<T>(urls[index])
      } catch (err) {
        results[index] = err instanceof Error ? err : new Error(String(err))
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => run())
  )
  return results
}
