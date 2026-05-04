import { NextResponse } from "next/server"

const YAHOO_QUOTE =
  "https://query1.finance.yahoo.com/v7/finance/quote?symbols=CYPH&fields=" +
  [
    "regularMarketPrice",
    "regularMarketChange",
    "regularMarketChangePercent",
    "regularMarketPreviousClose",
    "regularMarketTime",
    "preMarketPrice",
    "preMarketChange",
    "preMarketChangePercent",
    "preMarketTime",
    "postMarketPrice",
    "postMarketChange",
    "postMarketChangePercent",
    "postMarketTime",
    "marketState",
    "shortName",
    "currency",
  ].join(",")

export async function GET() {
  try {
    const res = await fetch(YAHOO_QUOTE, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 15 }, // cache 15s — quote data updates frequently
    })

    if (!res.ok) {
      throw new Error(`Yahoo quote fetch failed: ${res.status}`)
    }

    const json = await res.json()
    const q = json?.quoteResponse?.result?.[0]

    if (!q) throw new Error("No quote data returned")

    return NextResponse.json({
      symbol: q.symbol ?? "CYPH",
      shortName: q.shortName ?? "Cypherpunk Holdings",
      currency: q.currency ?? "USD",
      // Market state: PRE | REGULAR | POST | CLOSED | PREPRE | POSTPOST
      marketState: q.marketState ?? "CLOSED",
      // Regular session
      regularMarketPrice: q.regularMarketPrice ?? null,
      regularMarketChange: q.regularMarketChange ?? null,
      regularMarketChangePercent: q.regularMarketChangePercent ?? null,
      regularMarketPreviousClose: q.regularMarketPreviousClose ?? null,
      regularMarketTime: q.regularMarketTime ?? null, // unix seconds
      // Pre-market
      preMarketPrice: q.preMarketPrice ?? null,
      preMarketChange: q.preMarketChange ?? null,
      preMarketChangePercent: q.preMarketChangePercent ?? null,
      preMarketTime: q.preMarketTime ?? null,
      // Post-market
      postMarketPrice: q.postMarketPrice ?? null,
      postMarketChange: q.postMarketChange ?? null,
      postMarketChangePercent: q.postMarketChangePercent ?? null,
      postMarketTime: q.postMarketTime ?? null,
    })
  } catch (err) {
    console.error("[v0] Quote API error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
