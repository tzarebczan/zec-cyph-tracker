"use client"

import { useEffect, useRef, useState } from "react"
import { ExternalLink, RefreshCw, Satellite, ShieldCheck } from "lucide-react"
import useSWR from "swr"
import type { IronwoodLiveResponse } from "@/lib/ironwood-live"
import { swrFetcher } from "@/components/format"
import { CornerBox, Skeleton } from "@/components/primitives"
import { paletteVar } from "@/components/theme"
import { IronwoodHero } from "./countdown"
import { IronwoodConsole } from "./explorer"
import { formatTime } from "./utils"

const IRONWOOD = "#f6c945"
const CYAN = "#67e8f9"
const CELEBRATION_KEY = "cyphzec.ironwood.activation-celebrated.v1"

export function IronwoodDashboard() {
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<IronwoodLiveResponse>("/api/ironwood/live", swrFetcher, {
    refreshInterval: (latest) =>
      latest?.overview.blocksUntilActivation != null &&
      latest.overview.blocksUntilActivation <= 50
        ? 5_000
        : 10_000,
    dedupingInterval: 4_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
    refreshWhenHidden: false,
    shouldRetryOnError: true,
    errorRetryInterval: 8_000,
  })
  const [now, setNow] = useState(() => Date.now())
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const previousActivated = useRef<boolean | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!data?.blocks.length) return
    setSelectedBlock((current) =>
      current != null && data.blocks.some((block) => block.height === current)
        ? current
        : data.blocks[0].height
    )
  }, [data?.blocks])

  useEffect(() => {
    if (!data) return
    const wasActivated = previousActivated.current
    previousActivated.current = data.overview.activated
    if (!data.overview.activated) return
    const alreadyCelebrated =
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(CELEBRATION_KEY) === "1"
    if ((wasActivated === false || wasActivated === null) && !alreadyCelebrated) {
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      if (!reduced) {
        setCelebrating(true)
        window.setTimeout(() => setCelebrating(false), 5_500)
      }
      window.sessionStorage.setItem(CELEBRATION_KEY, "1")
    }
  }, [data])

  return (
    <main className="pb-2">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-[clamp(1rem,3vw,1.45rem)] font-bold tracking-[0.24em]"
              style={{ color: CYAN }}
            >
              IRONWOOD // LIVE
            </h1>
            <span
              className="inline-flex items-center gap-1 border px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em]"
              style={{ color: IRONWOOD, borderColor: `${IRONWOOD}55` }}
            >
              <ShieldCheck aria-hidden="true" size={10} />
              NU6.3
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-[10px] leading-relaxed" style={{ opacity: 0.54 }}>
            BLOCK-BY-BLOCK ACTIVATION, ORCHARD MIGRATION FLOW, MEMPOOL,
            PRIVACY COHORTS, AND SUPPLY VERIFICATION.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://cipherscan.app/ironwood"
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-8 items-center gap-1.5 border px-2 text-[9px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: CYAN,
              borderColor: `${CYAN}38`,
              outlineColor: CYAN,
            }}
          >
            SOURCE
            <ExternalLink aria-hidden="true" size={10} />
          </a>
          <button
            type="button"
            onClick={() => void mutate()}
            disabled={isValidating}
            className="grid size-8 place-items-center border focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 disabled:opacity-50"
            style={{
              color: IRONWOOD,
              borderColor: `${IRONWOOD}55`,
              outlineColor: IRONWOOD,
            }}
            title="Refresh Ironwood data"
            aria-label="Refresh Ironwood data"
          >
            <RefreshCw
              aria-hidden="true"
              size={13}
              className={isValidating ? "animate-spin" : ""}
            />
          </button>
        </div>
      </header>

      {data ? (
        <>
          <IronwoodHero
            overview={data.overview}
            blocks={data.blocks}
            now={now}
            selectedBlock={selectedBlock}
            onSelectBlock={setSelectedBlock}
            celebrating={celebrating}
          />
          <IronwoodConsole
            data={data}
            now={now}
          />
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-[8px] tracking-[0.12em]" style={{ borderColor: `${CYAN}20`, opacity: 0.48 }}>
            <span className="inline-flex items-center gap-1.5">
              <Satellite aria-hidden="true" size={10} />
              CIPHERSCAN MAINNET
            </span>
            <span className="tabular-nums">
              LIVE SNAPSHOT {formatTime(Math.floor(data.liveFetchedAt / 1000))}
              {data.analyticsFetchedAt
                ? ` // ANALYTICS ${formatTime(Math.floor(data.analyticsFetchedAt / 1000))}`
                : ""}
            </span>
          </footer>
        </>
      ) : isLoading ? (
        <IronwoodLoading />
      ) : (
        <IronwoodError onRetry={() => void mutate()} detail={error?.message} />
      )}
    </main>
  )
}

function IronwoodLoading() {
  return (
    <div className="space-y-3" aria-label="Loading Ironwood tracker">
      <CornerBox color={IRONWOOD}>
        <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <Skeleton width={150} height={20} />
            <Skeleton className="mt-4" width="82%" height={44} />
            <div className="mt-4 grid grid-cols-4 gap-px">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} height={68} />
              ))}
            </div>
          </div>
          <Skeleton height={180} />
        </div>
      </CornerBox>
      <CornerBox color={CYAN}>
        <Skeleton height={92} />
      </CornerBox>
      <CornerBox color={paletteVar("text")}>
        <Skeleton height={260} />
      </CornerBox>
    </div>
  )
}

function IronwoodError({
  onRetry,
  detail,
}: {
  onRetry: () => void
  detail?: string
}) {
  return (
    <CornerBox color={IRONWOOD} className="min-h-72">
      <div className="grid min-h-64 place-items-center text-center">
        <div>
          <div className="text-sm font-bold tracking-[0.16em]" style={{ color: IRONWOOD }}>
            LIVE TRACKER TEMPORARILY OFFLINE
          </div>
          <p className="mt-2 max-w-md text-[10px] leading-relaxed" style={{ opacity: 0.52 }}>
            THE LAST GOOD SNAPSHOT WAS NOT AVAILABLE AT THIS EDGE YET.
            RETRY TO RECONNECT TO CIPHERSCAN.
          </p>
          {detail && (
            <p className="mt-2 text-[8px]" style={{ opacity: 0.35 }}>
              {detail}
            </p>
          )}
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex min-h-9 items-center gap-2 border px-3 text-[9px] font-bold tracking-[0.14em] focus-visible:outline focus-visible:outline-1"
            style={{
              color: IRONWOOD,
              borderColor: `${IRONWOOD}66`,
              outlineColor: IRONWOOD,
            }}
          >
            <RefreshCw aria-hidden="true" size={12} />
            RETRY STREAM
          </button>
        </div>
      </div>
    </CornerBox>
  )
}
