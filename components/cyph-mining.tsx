"use client"

import Link from "next/link"
import { Pickaxe } from "lucide-react"
import useSWR from "swr"
import type { ZecMiningResponse } from "@/app/api/zec-mining/route"
import type { HoldingsResponse } from "./api-types"
import { CornerBox, InfoTip, Skeleton } from "./primitives"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { paletteVar } from "./theme"
import { estimateCyphMining, type CyphMiningEstimate } from "@/lib/cyph-mining"

const MINING = "#f59e0b"

/** Shared SWR config. Network hashrate drifts slowly; no need to be eager. */
const MINING_SWR = {
  refreshInterval: 5 * 60_000,
  keepPreviousData: true,
  revalidateOnFocus: true,
} as const

function useCyphMining(): {
  estimate: CyphMiningEstimate | null
  investedUSD: number | null
  loading: boolean
} {
  const { data: network } = useSWR<ZecMiningResponse>(
    "/api/zec-mining",
    swrFetcher,
    MINING_SWR
  )
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    MINING_SWR
  )
  const mining = holdings?.mining ?? null
  if (!network) return { estimate: null, investedUSD: null, loading: true }
  return {
    estimate: estimateCyphMining({
      network,
      startedAt: mining?.startedAt ?? null,
      now: Date.now(),
    }),
    investedUSD: mining?.investedUSD ?? null,
    loading: false,
  }
}

function fmtZec(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/* ── Treasury page panel ─────────────────────────────────────────────── */

export function MiningPanel({
  zecPrice,
  className,
}: {
  zecPrice: number | null
  /** Grid placement from the caller. */
  className?: string
}) {
  const { estimate, investedUSD, loading } = useCyphMining()

  if (loading) {
    return (
      <CornerBox label="MINING" color={MINING} className={className}>
        <Skeleton className="mt-2" height={120} />
      </CornerBox>
    )
  }
  if (!estimate) return null

  const minedToDate = estimate.estZecToDate

  return (
    <CornerBox
      label={
        <span className="inline-flex items-center gap-1.5">
          <Pickaxe aria-hidden="true" size={12} />
          MINING
        </span>
      }
      color={MINING}
      className={className}
      action={
        <span className="inline-flex items-center gap-1" style={{ color: MINING }}>
          EST
          <InfoTip color={MINING} label="How the mining estimate works" size={13}>
            <p>
              Cypherpunk discloses the capital deployed and a fleet hashrate,
              but no ZEC-mined figure. These are our estimates.
            </p>
            <p className="mt-2">
              Fleet {estimate.fleetGSolS} GSol/s ÷ network{" "}
              {fmtZec(estimate.networkGSolS, 2)} GSol/s ={" "}
              {estimate.sharePct?.toFixed(2)}% of hashrate, applied to the{" "}
              {fmtZec(estimate.estZecPerDay != null && estimate.sharePct ? estimate.estZecPerDay / (estimate.sharePct / 100) : null)}{" "}
              ZEC/day the network pays miners.
            </p>
            <p className="mt-2">
              &ldquo;To date&rdquo; assumes the fleet ran at its current size
              from {estimate.startedAt?.slice(0, 10) ?? "launch"} and that
              network hashrate held flat, so treat it as an order of magnitude
              rather than a number. Fleet figure read from cypherpunk.com on{" "}
              {estimate.fleetObservedAt}.
            </p>
          </InfoTip>
        </span>
      }
    >
      <div className="mt-2">
        <div className="text-[10px] tracking-[0.16em]" style={{ opacity: 0.55 }}>
          EST. MINED TO DATE
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-2xl font-bold tabular-nums md:text-3xl"
            style={{ color: MINING }}
          >
            {fmtZec(minedToDate)} ZEC
          </span>
          {minedToDate != null && zecPrice != null && (
            <span className="text-[11px] tabular-nums" style={{ opacity: 0.7 }}>
              ≈ {fmtCompactUSD(minedToDate * zecPrice)}
            </span>
          )}
        </div>
      </div>

      <div
        className="mt-3 grid grid-cols-2 gap-px border md:grid-cols-4"
        style={{ borderColor: `${MINING}33` }}
      >
        <MiningCell label="FLEET" value={`${estimate.fleetGSolS} GSOL/S`} color={MINING} />
        <MiningCell
          label="NETWORK SHARE"
          value={estimate.sharePct != null ? `${estimate.sharePct.toFixed(2)}%` : "—"}
          color={paletteVar("cyph")}
        />
        <MiningCell label="EST. ZEC / DAY" value={fmtZec(estimate.estZecPerDay, 1)} />
        <MiningCell label="EST. TODAY" value={fmtZec(estimate.estZecToday, 1)} />
      </div>

      <div
        className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] tracking-[0.12em]"
        style={{ opacity: 0.5 }}
      >
        <span>
          {investedUSD != null ? `${fmtCompactUSD(investedUSD)} DEPLOYED` : "—"}
          {estimate.daysLive != null && ` · LIVE ${estimate.daysLive.toFixed(1)}D`}
        </span>
        <span>
          {estimate.zecPerGSolPerDay != null
            ? `${estimate.zecPerGSolPerDay.toFixed(1)} ZEC / GSOL / DAY`
            : ""}
        </span>
      </div>
    </CornerBox>
  )
}

function MiningCell({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <div className="min-w-0 px-2 py-2">
      <div className="truncate text-[8px] tracking-[0.14em]" style={{ opacity: 0.5 }}>
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[11px] font-bold tabular-nums"
        style={{ color: color ?? paletteVar("text") }}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

/* ── Dashboard CYPH tile chip ────────────────────────────────────────── */

/** Mining run-rate for the CYPH tile header, sharing the TILE_CHIP geometry
 *  used by the OPEN / #rank / LIVE chips so the header row stays one line.
 *
 *  `~` carries the estimate caveat that the treasury panel spells out in full —
 *  the header has room for a number, not a disclaimer. Renders nothing until a
 *  mining outlay is disclosed. */
export function MiningChip() {
  const { estimate, loading } = useCyphMining()
  if (loading || !estimate || estimate.startedAt == null) return null
  const perDay = estimate.estZecPerDay
  if (perDay == null) return null

  return (
    <Link
      href="/holdings"
      className="group box-border inline-flex h-[18px] min-h-[18px] max-h-[18px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0 text-[9px] font-bold leading-none tracking-[0.1em] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{
        borderColor: `${MINING}55`,
        color: MINING,
        outlineColor: MINING,
      }}
      title={`Cypherpunk Mining — estimated ${fmtZec(perDay, 0)} ZEC/day from a ${estimate.fleetGSolS} GSol/s fleet`}
    >
      <Pickaxe aria-hidden="true" size={9} />
      <span className="tabular-nums">~{fmtZec(perDay, 0)}</span>
      <span style={{ color: paletteVar("text"), opacity: 0.7 }}>ZEC/D</span>
    </Link>
  )
}
