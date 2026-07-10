"use client"

import Link from "next/link"
import { useEffect } from "react"
import { CornerBox } from "./primitives"
import { paletteVar } from "./theme"
import {
  FEATURE_UPDATES,
  updateBadgeColor,
  type FeatureUpdate,
} from "./updates-data"
import { useFeatureUpdates } from "./use-feature-updates"

function fmtDate(date: string) {
  const ms = Date.parse(date)
  if (!Number.isFinite(ms)) return date
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

function UpdateCard({ update, first }: { update: FeatureUpdate; first: boolean }) {
  const color = updateBadgeColor(update)
  const shipped = fmtDate(update.shippedAt)
  const updated = fmtDate(update.updatedAt)
  return (
    <CornerBox color={color}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em]"
              style={{
                color,
                borderColor: `${color}66`,
                boxShadow: first ? `0 0 10px ${color}22` : "none",
              }}
            >
              {update.badge}
            </span>
            {first && (
              <span
                className="text-[9px] font-bold tracking-[0.16em]"
                style={{ color: paletteVar("cyph") }}
              >
                LATEST
              </span>
            )}
            <span
              className="text-[10px] tracking-[0.14em] tabular-nums"
              style={{ color: paletteVar("text"), opacity: 0.55 }}
            >
              SHIPPED {shipped}
              {update.updatedAt !== update.shippedAt ? ` / UPDATED ${updated}` : ""}
            </span>
          </div>
          <h2
            className="mt-2 text-lg md:text-xl font-bold tracking-[0.14em]"
            style={{ color }}
          >
            {update.title}
          </h2>
          <p
            className="mt-1 max-w-3xl text-[12px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.75 }}
          >
            {update.summary}
          </p>
          <div className="mt-3 grid gap-1.5 md:grid-cols-2">
            {update.details.map((detail) => (
              <div
                key={detail}
                className="border px-2 py-1.5 text-[11px] leading-snug whitespace-normal break-words"
                style={{
                  borderColor: `${paletteVar("text")}22`,
                  color: paletteVar("text"),
                  opacity: 0.72,
                }}
              >
                {detail}
              </div>
            ))}
          </div>
        </div>
        <Link
          href={update.href}
          className="inline-flex shrink-0 items-center justify-center border px-3 py-2 text-[11px] font-bold tracking-[0.16em] hover:underline"
          style={{ color, borderColor: `${color}66` }}
        >
          OPEN
        </Link>
      </div>
    </CornerBox>
  )
}

export function Updates() {
  const { markLatestSeen } = useFeatureUpdates()

  useEffect(() => {
    markLatestSeen()
  }, [markLatestSeen])

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">
          FEATURES / UPDATES
        </h1>
        <span
          className="text-[11px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          new tools and release notes
        </span>
      </div>
      <div className="space-y-3">
        {FEATURE_UPDATES.map((update, index) => (
          <UpdateCard key={update.id} update={update} first={index === 0} />
        ))}
      </div>
      <footer
        className="mt-3 flex flex-wrap items-center gap-2 text-[11px]"
        style={{ color: paletteVar("text"), opacity: 0.58 }}
      >
        <Link href="/more" className="hover:underline" style={{ color: paletteVar("cyph") }}>
          MORE
        </Link>
        <span>/</span>
        <Link href="/shielding" className="hover:underline" style={{ color: paletteVar("ratio") }}>
          SHIELDING
        </Link>
      </footer>
    </>
  )
}
