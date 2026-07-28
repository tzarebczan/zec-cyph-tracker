import { NextRequest, NextResponse } from "next/server"
import type { IronwoodTxDetail } from "@/lib/ironwood-live"

export const dynamic = "force-dynamic"

const CIPHERSCAN = "https://api.mainnet.cipherscan.app/api"
const UPSTREAM_TIMEOUT_MS = 8_000
const RESPONSE_HEADERS = {
  "Cache-Control":
    "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
}

interface RawTx {
  txid?: string
  blockHeight?: string | number
  block_height?: string | number
  blockTime?: string | number
  block_time?: string | number
  confirmations?: string | number
  size?: string | number
  version?: string | number
  fee?: string | number
  inputCount?: string | number
  vin_count?: string | number
  outputCount?: string | number
  vout_count?: string | number
  orchardActions?: string | number
  orchard_actions?: string | number
  ironwoodActions?: string | number
  ironwood_actions?: string | number
  valueBalanceOrchard?: string | number
  value_balance_orchard?: string | number
  valueBalanceIronwood?: string | number
  value_balance_ironwood?: string | number
  hasOrchard?: boolean
  has_orchard?: boolean
  hasIronwood?: boolean
  has_ironwood?: boolean
  isCoinbase?: boolean
  is_coinbase?: boolean
  isCanonical?: boolean
  is_canonical?: boolean
}

function finite(value: string | number | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function optionalFinite(
  value: string | number | null | undefined
): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function GET(request: NextRequest) {
  const txid = request.nextUrl.searchParams.get("txid")?.trim() ?? ""
  if (!/^[a-f0-9]{64}$/i.test(txid)) {
    return NextResponse.json(
      { error: "A valid transaction hash is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(`${CIPHERSCAN}/tx/${txid}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Origin: "https://cipherscan.app",
        Referer: "https://cipherscan.app/ironwood",
      },
      next: { revalidate: 30 },
    })
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 404 ? "Transaction not found" : "CipherScan unavailable" },
        {
          status: response.status === 404 ? 404 : 502,
          headers: { "Cache-Control": "no-store" },
        }
      )
    }

    const raw = (await response.json()) as RawTx
    const detail: IronwoodTxDetail = {
      txid: raw.txid ?? txid,
      blockHeight: optionalFinite(raw.blockHeight ?? raw.block_height),
      blockTime: optionalFinite(raw.blockTime ?? raw.block_time),
      confirmations: optionalFinite(raw.confirmations),
      size: finite(raw.size),
      version: finite(raw.version),
      feeZec: finite(raw.fee),
      vinCount: finite(raw.inputCount ?? raw.vin_count),
      voutCount: finite(raw.outputCount ?? raw.vout_count),
      orchardActions: finite(raw.orchardActions ?? raw.orchard_actions),
      ironwoodActions: finite(raw.ironwoodActions ?? raw.ironwood_actions),
      orchardValueBalanceZec: finite(
        raw.valueBalanceOrchard ?? raw.value_balance_orchard
      ),
      ironwoodValueBalanceZec: finite(
        raw.valueBalanceIronwood ?? raw.value_balance_ironwood
      ),
      hasOrchard: raw.hasOrchard ?? raw.has_orchard ?? false,
      hasIronwood: raw.hasIronwood ?? raw.has_ironwood ?? false,
      isCoinbase: raw.isCoinbase ?? raw.is_coinbase ?? false,
      isCanonical: raw.isCanonical ?? raw.is_canonical ?? null,
    }

    return NextResponse.json(detail, { headers: RESPONSE_HEADERS })
  } catch (error) {
    console.error("[ironwood-tx] detail fetch failed", error)
    return NextResponse.json(
      { error: "Transaction detail is temporarily unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    )
  } finally {
    clearTimeout(timeout)
  }
}
