import { NextResponse } from "next/server"

// Proxies cypherpunk.com's public Payload-CMS transactions endpoint and
// computes the aggregates we want to show (total ZEC held, total cost
// basis, average cost per ZEC, last transaction date). The upstream lives
// at https://cypherpunk.com/api/transactions and is JSON, so no scraping
// or HTML parsing — we just fetch + reshape.
//
// Transactions don't change often (a few per quarter at most), so we
// cache the result hard at the CF edge and serve a stale-while-revalidate
// window to absorb upstream blips.

const UPSTREAM_URL = "https://cypherpunk.com/api/transactions?limit=200"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface UpstreamTx {
  id?: string
  date?: string
  type?: "buy" | "sell" | string
  asset?: { name?: string; symbol?: string; website?: string | null }
  amount?: number | null
  unitPrice?: number | null
  totalValue?: number | null
  fees?: number | null
  source?: string | null
  notes?: string | null
}

interface UpstreamResponse {
  docs?: UpstreamTx[]
  totalDocs?: number
}

interface NormalizedTx {
  id: string
  date: string
  type: "buy" | "sell"
  assetSymbol: string
  assetName: string
  amount: number | null
  unitPrice: number | null
  totalValue: number | null
}

interface Summary {
  totalZec: number
  totalCostUSD: number
  avgCostPerZec: number | null
  transactionCount: number
  buyCount: number
  sellCount: number
  firstTransactionAt: string | null
  lastTransactionAt: string | null
}

function normalize(docs: UpstreamTx[]): NormalizedTx[] {
  return docs.map((t) => ({
    id: String(t.id ?? ""),
    date: String(t.date ?? ""),
    type: t.type === "sell" ? "sell" : "buy",
    assetSymbol: t.asset?.symbol ?? "",
    assetName: t.asset?.name ?? "",
    amount: typeof t.amount === "number" ? t.amount : null,
    unitPrice: typeof t.unitPrice === "number" ? t.unitPrice : null,
    totalValue: typeof t.totalValue === "number" ? t.totalValue : null,
  }))
}

function summarize(txs: NormalizedTx[]): Summary {
  // Treat ZEC transactions only (the company holds only ZEC right now;
  // future-proof by filtering on the symbol). Skip rows where amount is
  // null or 0 — those appear to be placeholder / draft entries upstream
  // (e.g. one row in the live feed has amount=0 and totalValue=\$5M).
  const zec = txs.filter(
    (t) => t.assetSymbol === "ZEC" && (t.amount ?? 0) > 0
  )
  let totalZec = 0
  let totalCostUSD = 0
  let buyCount = 0
  let sellCount = 0
  for (const t of zec) {
    const sign = t.type === "buy" ? 1 : -1
    totalZec += (t.amount ?? 0) * sign
    totalCostUSD += (t.totalValue ?? 0) * sign
    if (t.type === "buy") buyCount++
    else sellCount++
  }
  const sortedByDate = [...txs].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
  return {
    totalZec,
    totalCostUSD,
    avgCostPerZec: totalZec > 0 ? totalCostUSD / totalZec : null,
    transactionCount: txs.length,
    buyCount,
    sellCount,
    firstTransactionAt: sortedByDate[0]?.date ?? null,
    lastTransactionAt: sortedByDate[sortedByDate.length - 1]?.date ?? null,
  }
}

export async function GET() {
  try {
    const res = await fetch(UPSTREAM_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    const json = (await res.json()) as UpstreamResponse
    const txs = normalize(json.docs ?? [])
    // Newest first for display
    txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    const summary = summarize(txs)
    return NextResponse.json(
      { transactions: txs, summary, fetchedAt: Date.now() },
      {
        headers: {
          // CF edge caches for 6h, stale-while-revalidate for 24h. Buys
          // happen at most every few weeks, so this is plenty fresh.
          "Cache-Control":
            "public, s-maxage=21600, stale-while-revalidate=86400",
        },
      }
    )
  } catch (err) {
    console.error("[v0] cypherpunk-holdings: upstream fetch failed", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    )
  }
}
