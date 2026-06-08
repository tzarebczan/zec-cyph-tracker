export function wantsCompleteOgImage(request: Request): boolean {
  const url = new URL(request.url)
  return (
    url.searchParams.get("requireData") === "1" ||
    url.searchParams.get("complete") === "1"
  )
}

export function ogHeaders(
  requireComplete: boolean,
  defaultCacheControl: string
): Record<string, string> {
  return {
    "Cache-Control": requireComplete
      ? "no-store, max-age=0"
      : defaultCacheControl,
  }
}

export function missingOgDataResponse(
  route: string,
  missing: string[]
): Response {
  return Response.json(
    {
      error: "OG image data incomplete",
      route,
      missing,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  )
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}
