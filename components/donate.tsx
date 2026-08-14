"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { renderSVG } from "uqr"
import { CornerBox } from "./primitives"
import { paletteVar } from "./theme"
import {
  DONATE_BLURB,
  DONATE_ZEC_ADDRESS,
  DONATE_ZIP321,
} from "@/lib/donate"

function DonateQr({ value }: { value: string }) {
  const svg = useMemo(
    () =>
      renderSVG(value, {
        ecc: "M",
        border: 2,
        pixelSize: 4,
        blackColor: "#111111",
        whiteColor: "#ffffff",
      }),
    [value],
  )
  return (
    <div
      role="img"
      aria-label="ZIP 321 payment QR code"
      className="w-[220px] h-[220px] [&_svg]:block [&_svg]:h-full [&_svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function CopyChip({
  label,
  text,
}: {
  label: string
  text: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch {
          setCopied(false)
        }
      }}
      className="px-2 py-1 text-[11px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40"
      style={{
        color: paletteVar("text"),
        opacity: 0.85,
        border: `1px solid ${paletteVar("text")}33`,
      }}
    >
      {copied ? "COPIED" : label}
    </button>
  )
}

export function Donate() {
  return (
    <div className="max-w-3xl mx-auto py-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-[0.2em]">DONATE</h1>
        <p
          className="text-[15px] mt-3 leading-relaxed font-bold"
          style={{ color: paletteVar("zec") }}
        >
          {DONATE_BLURB}
        </p>
        <p
          className="text-[13px] mt-2 leading-relaxed max-w-2xl"
          style={{ color: paletteVar("text"), opacity: 0.85 }}
        >
          Optional ZEC to a shielded unified address. Scan the QR or tap Open
          wallet — both use a{" "}
          <a
            href="https://zips.z.cash/zip-0321"
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold hover:underline"
            style={{ color: paletteVar("cyph") }}
          >
            ZIP 321
          </a>{" "}
          payment URI so compatible wallets can fill the send screen.
        </p>
      </div>

      <CornerBox color={paletteVar("zec")}>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <div
            className="p-2 shrink-0"
            style={{ background: "#fff", border: `1px solid ${paletteVar("zec")}55` }}
          >
            <DonateQr value={DONATE_ZIP321} />
          </div>
          <div className="flex flex-col gap-3 min-w-0">
            <div
              className="text-[11px] tracking-[0.3em] font-bold"
              style={{ color: paletteVar("zec") }}
            >
              SHIELDED ZEC
            </div>
            <p
              className="text-[12px] leading-relaxed break-all font-mono"
              style={{ color: paletteVar("text"), opacity: 0.9 }}
            >
              {DONATE_ZEC_ADDRESS}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyChip label="COPY ADDRESS" text={DONATE_ZEC_ADDRESS} />
              <CopyChip label="COPY ZIP 321" text={DONATE_ZIP321} />
              <a
                href={DONATE_ZIP321}
                className="px-2 py-1 text-[11px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40 inline-flex items-center"
                style={{
                  color: paletteVar("text"),
                  opacity: 0.85,
                  border: `1px solid ${paletteVar("text")}33`,
                }}
              >
                OPEN WALLET
              </a>
            </div>
          </div>
        </div>
      </CornerBox>

      <p
        className="text-[12px]"
        style={{ color: paletteVar("text"), opacity: 0.55 }}
      >
        <Link href="/about" className="hover:underline" style={{ color: paletteVar("cyph") }}>
          Back to FAQ
        </Link>
      </p>
    </div>
  )
}
