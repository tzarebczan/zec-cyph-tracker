"use client"

import { useEffect, useRef, useState } from "react"
import { ExternalLink, RefreshCw, Satellite, ShieldCheck } from "lucide-react"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import type { IronwoodLiveResponse } from "@/lib/ironwood-live"
import { swrFetcher } from "@/components/format"
import { CornerBox, Skeleton } from "@/components/primitives"
import { paletteVar } from "@/components/theme"
import { IronwoodHero } from "./countdown"
import { IronwoodConsole } from "./explorer"
import { formatTime } from "./utils"

const IRONWOOD = "#f6c945"
const CYAN = "#67e8f9"
// localStorage, not sessionStorage: the burst should fire on the live flip
// and once for a first-time visitor who arrives just after activation — not
// on every new tab, forever, long after the migration is old news.
const CELEBRATION_KEY = "cyphzec.ironwood.activation-celebrated.v1"

export function IronwoodDashboard() {
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<IronwoodLiveResponse>("/api/ironwood/live", swrFetcher, {
    refreshInterval: (latest) => {
      const blocks = latest?.overview.blocksUntilActivation
      if (blocks == null || latest?.overview.activated) return 10_000
      if (blocks <= 1) return 3_000
      if (blocks <= 10) return 4_000
      if (blocks <= 50) return 5_000
      return 10_000
    },
    // Below the fastest interval above, or SWR drops those polls.
    dedupingInterval: 2_500,
    keepPreviousData: true,
    revalidateOnFocus: true,
    refreshWhenHidden: false,
    shouldRetryOnError: true,
    errorRetryInterval: 8_000,
  })
  const pageVisible = usePageVisible()
  const [now, setNow] = useState(() => Date.now())
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const previousActivated = useRef<boolean | null>(null)

  // One-second clock for the countdown / block ages. Paused while the tab is
  // hidden — nothing is on screen to tick, and it re-syncs on return.
  useEffect(() => {
    if (!pageVisible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

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
    let alreadyCelebrated = false
    try {
      alreadyCelebrated =
        window.localStorage.getItem(CELEBRATION_KEY) === "1"
    } catch {
      /* private mode / quota — treat as not yet celebrated */
    }
    if ((wasActivated === false || wasActivated === null) && !alreadyCelebrated) {
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      if (!reduced) {
        setCelebrating(true)
        window.setTimeout(() => setCelebrating(false), 5_500)
      }
      try {
        window.localStorage.setItem(CELEBRATION_KEY, "1")
      } catch {
        /* non-fatal — worst case the burst replays next visit */
      }
    }
  }, [data])

  return (
    <main className="pb-2">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1
            className="whitespace-nowrap text-[0.95rem] font-bold tracking-[0.2em] sm:text-[1.15rem] lg:text-[1.45rem] lg:tracking-[0.24em]"
            style={{ color: CYAN }}
          >
            IRONWOOD // LIVE
          </h1>
          <span
            className="inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[8px] font-bold tracking-[0.14em]"
            style={{ color: IRONWOOD, borderColor: `${IRONWOOD}55` }}
          >
            <ShieldCheck aria-hidden="true" size={10} />
            NU6.3
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href="https://cipherscan.app/ironwood"
            target="_blank"
            rel="noreferrer"
            aria-label="Open CipherScan Ironwood source"
            title="Open CipherScan Ironwood source"
            className="grid size-8 place-items-center border text-[9px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 sm:inline-flex sm:w-auto sm:gap-1.5 sm:px-2"
            style={{
              color: CYAN,
              borderColor: `${CYAN}38`,
              outlineColor: CYAN,
            }}
          >
            <span className="hidden sm:inline">SOURCE</span>
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
