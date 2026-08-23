"use client"

import useSWR from "swr"

import type { PricesResponse } from "./api-types"
import { swrFetcher } from "./format"
import { OrderFlowPanels } from "./order-depth"
import { useIsMobile } from "./primitives"

/** The ORDER FLOW view as a standalone page at /order-flow.
 *
 *  Same panels the /stats ORDER FLOW tab renders — this only supplies the two
 *  props that page had lying around. `/api/prices?days=90` is the daily
 *  history the RSI and drawdown figures are computed from; the depth, tape and
 *  intraday numbers all come from the panels' own /api/zec-depth poll, so this
 *  wrapper adds exactly one request over the tab. */
export function OrderFlowView() {
  const isMobile = useIsMobile()
  const { data: prices90 } = useSWR<PricesResponse>(
    "/api/prices?days=90",
    swrFetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )
  return (
    <OrderFlowPanels history={prices90?.history} isMobile={isMobile} />
  )
}
