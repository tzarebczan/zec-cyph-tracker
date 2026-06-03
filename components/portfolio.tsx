"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import {
  CornerBox,
  BlockProgress,
  LiveNumber,
  SingleLineChartE,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtUSD, swrFetcher } from "./format"
import { pickLiveCyph } from "./quote-utils"
import type { PricesResponse, QuoteSnapshot } from "./api-types"

// Shared with the legacy /portfolio page. Reading + writing the same
// key means a user's holdings work on whichever surface they open.
const HOLDINGS_KEY = "cyphzec.portfolio.v1"
const COST_BASIS_KEY = "cyphzec.beta.portfolio.costBasis"

interface Holdings {
  cyphShares: number | null
  zecCoins: number | null
}

function loadHoldings(): Holdings {
  if (typeof window === "undefined") return { cyphShares: null, zecCoins: null }
  try {
    const raw = window.localStorage.getItem(HOLDINGS_KEY)
    if (!raw) return { cyphShares: null, zecCoins: null }
    const p = JSON.parse(raw)
    return {
      cyphShares:
        typeof p?.cyphShares === "number" && p.cyphShares >= 0
          ? p.cyphShares
          : null,
      zecCoins:
        typeof p?.zecCoins === "number" && p.zecCoins >= 0 ? p.zecCoins : null,
    }
  } catch {
    return { cyphShares: null, zecCoins: null }
  }
}

function saveHoldings(h: Holdings) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(HOLDINGS_KEY, JSON.stringify(h))
  } catch {
    /* private mode / quota — non-fatal */
  }
}

function loadCostBasis(): number | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(COST_BASIS_KEY)
    const v = raw == null ? null : parseFloat(raw)
    return v != null && Number.isFinite(v) && v >= 0 ? v : null
  } catch {
    return null
  }
}

function saveCostBasis(v: number | null) {
  if (typeof window === "undefined") return
  try {
    if (v == null) window.localStorage.removeItem(COST_BASIS_KEY)
    else window.localStorage.setItem(COST_BASIS_KEY, String(v))
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function Portfolio() {
  // SSR-safe two-stage init: paint with empty, then hydrate from
  // localStorage to avoid an initial flash of stranger's holdings.
  const [hydrated, setHydrated] = useState(false)
  const [cyph, setCyph] = useState<number>(0)
  const [zec, setZec] = useState<number>(0)
  const [cost, setCost] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const h = loadHoldings()
    setCyph(h.cyphShares ?? 0)
    setZec(h.zecCoins ?? 0)
    setCost(loadCostBasis())
    setHydrated(true)
  }, [])
  // Auto-save on change after hydration.
  useEffect(() => {
    if (!hydrated) return
    saveHoldings({
      cyphShares: cyph > 0 ? cyph : null,
      zecCoins: zec > 0 ? zec : null,
    })
    saveCostBasis(cost)
    setSaved(true)
    const t = setTimeout(() => setSaved(false), 1100)
    return () => clearTimeout(t)
  }, [cyph, zec, cost, hydrated])

  // Cross-tab sync — `storage` events fire on other tabs whenever
  // localStorage changes in this tab (and vice-versa). Re-load on
  // either of our keys so opening the legacy /portfolio page in a
  // second tab and editing there is reflected here without a refresh.
  useEffect(() => {
    if (!hydrated) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === HOLDINGS_KEY) {
        const h = loadHoldings()
        setCyph(h.cyphShares ?? 0)
        setZec(h.zecCoins ?? 0)
      } else if (e.key === COST_BASIS_KEY) {
        setCost(loadCostBasis())
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [hydrated])

  const { data: prices } = useSWR<PricesResponse>(
    "/api/prices?days=90",
    swrFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  // Use the same live picker as the dashboard so navigating between
  // pages doesn't surface a different CYPH price for the same moment.
  const cyphPrice = pickLiveCyph(quote)
  const zecPrice = prices?.current?.zec?.price ?? null

  const cyphVal = cyphPrice != null ? cyph * cyphPrice : null
  const zecVal = zecPrice != null ? zec * zecPrice : null
  const total = cyphVal != null && zecVal != null ? cyphVal + zecVal : null
  const pnl =
    total != null && cost != null && Number.isFinite(cost) ? total - cost : null
  const pnlPct = pnl != null && cost && cost > 0 ? (pnl / cost) * 100 : null

  const history = prices?.history ?? []

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">PORTFOLIO</h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          private · on-device only
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 transition-opacity"
          style={{
            color: paletteVar("ratio"),
            border: `1px solid ${paletteVar("ratio")}55`,
            opacity: saved ? 1 : 0.55,
          }}
        >
          🔒 {saved ? "SAVED" : "ON-DEVICE"}
        </span>
      </div>

      <CornerBox label="TOTAL VALUE" color={paletteVar("ratio")} className="mb-3">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
        >
          <div>
            <div
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              NET VALUE · LIVE
            </div>
            <div className="text-4xl font-bold mt-1 leading-none">
              <LiveNumber
                value={total}
                format={fmtUSD}
                color={paletteVar("ratio")}
              />
            </div>
            {pnl != null && pnlPct != null && (
              <div
                className="text-[11px] mt-2 tabular-nums"
                style={{ color: pnl >= 0 ? paletteVar("cyph") : E_STATIC.red }}
              >
                {pnl >= 0 ? "▲" : "▼"} {fmtUSD(Math.abs(pnl))} (
                {pnl >= 0 ? "+" : ""}
                {pnlPct.toFixed(2)}%) vs cost basis
              </div>
            )}
          </div>
          <PortfolioCell
            label="CYPH HOLDINGS"
            color={paletteVar("cyph")}
            value={cyphVal}
            qty={cyph}
            qtyLabel="shares"
            price={cyphPrice}
            sharePct={total != null && total > 0 ? ((cyphVal ?? 0) / total) * 100 : null}
          />
          <PortfolioCell
            label="ZEC HOLDINGS"
            color={paletteVar("zec")}
            value={zecVal}
            qty={zec}
            qtyLabel="ZEC"
            price={zecPrice}
            sharePct={total != null && total > 0 ? ((zecVal ?? 0) / total) * 100 : null}
          />
        </div>
      </CornerBox>

      <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-3">
        <CornerBox label="HOLDINGS">
          <InputRow
            label="CYPH SHARES"
            color={paletteVar("cyph")}
            value={cyph}
            onChange={setCyph}
            suffix="CYPH"
          />
          <InputRow
            label="ZEC"
            color={paletteVar("zec")}
            value={zec}
            onChange={setZec}
            suffix="ZEC"
          />
          <label className="flex flex-col gap-1 mt-2">
            <span
              className="text-[10px]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              COST BASIS (OPTIONAL)
            </span>
            <div
              className="flex items-center border"
              style={{ borderColor: `${paletteVar("text")}55` }}
            >
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={cost ?? ""}
                onChange={(e) => {
                  const v = e.target.value
                  setCost(v === "" ? null : parseFloat(v))
                }}
                placeholder="—"
                className="flex-1 bg-transparent px-2 py-1.5 font-mono text-sm tabular-nums outline-none w-full"
                style={{ color: paletteVar("text"), caretColor: paletteVar("text") }}
              />
              <span
                className="px-2 text-[10px]"
                style={{
                  color: paletteVar("text"),
                  opacity: 0.7,
                  borderLeft: `1px solid ${paletteVar("text")}55`,
                }}
              >
                USD
              </span>
            </div>
          </label>
          <p
            className="mt-3 text-[10px] leading-relaxed"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            Stored only in your browser. Cross-tab updates are picked up
            automatically. Nothing is sent to the server.
          </p>
        </CornerBox>

        <CornerBox label="VALUE · 90D">
          {cyph === 0 && zec === 0 ? (
            <div
              className="text-[11px] py-12 text-center"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              Enter CYPH or ZEC holdings to chart portfolio value.
            </div>
          ) : history.length === 0 ? (
            <div
              className="text-[11px] py-12 text-center"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              Loading 90-day price history…
            </div>
          ) : history.length >= 2 ? (
            <SingleLineChartE
              // Total portfolio value backtested against historical
              // closes — simulates what the user's current holdings
              // would have been worth on each prior day. Single line
              // (one series) so the tooltip / labels read cleanly.
              data={history.flatMap((h) =>
                h.cyph == null && cyph > 0
                  ? []
                  : [
                      {
                        date: h.date,
                        value: (h.cyph ?? 0) * cyph + h.zec * zec,
                      },
                    ]
              )}
              height={260}
              color={paletteVar("ratio")}
              valueFormat={fmtUSD}
              emptyMessage="Need a few days of price history."
            />
          ) : (
            <div
              className="text-[11px] py-12 text-center"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              Need a few days of price history to chart portfolio value.
            </div>
          )}
        </CornerBox>
      </div>
    </>
  )
}

function PortfolioCell({
  label,
  color,
  value,
  qty,
  qtyLabel,
  price,
  sharePct,
}: {
  label: string
  color: string
  value: number | null
  qty: number
  qtyLabel: string
  price: number | null
  sharePct: number | null
}) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em]" style={{ color }}>
        {label}
      </div>
      <div className="text-2xl font-bold mt-1 leading-none">
        <LiveNumber value={value} format={fmtUSD} color={color} />
      </div>
      <div
        className="text-[10px] mt-1"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {qty} {qtyLabel}
        {price != null ? ` @ $${price.toFixed(2)}` : ""}
      </div>
      {sharePct != null && (
        <div className="mt-2">
          <BlockProgress
            pct={sharePct}
            width={22}
            color={color}
            animated={false}
            sub={sharePct.toFixed(0) + "%"}
          />
        </div>
      )}
    </div>
  )
}

function InputRow({
  label,
  value,
  onChange,
  color,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  color: string
  suffix: string
}) {
  return (
    <label className="flex flex-col gap-1 mt-2 first:mt-0">
      <span
        className="text-[10px]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {label}
      </span>
      <div className="flex items-center border" style={{ borderColor: `${color}55` }}>
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value || ""}
          placeholder="0"
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="flex-1 bg-transparent px-2 py-1.5 font-mono text-sm tabular-nums outline-none w-full"
          style={{ color, caretColor: color }}
        />
        <span
          className="px-2 text-[10px]"
          style={{
            color,
            opacity: 0.7,
            borderLeft: `1px solid ${color}55`,
          }}
        >
          {suffix}
        </span>
      </div>
    </label>
  )
}
