import { NextResponse } from "next/server"

/**
 * Expose the current build version so the client can detect when a new
 * deployment has happened and prompt the user to refresh.
 *
 * Priority:
 *   1. NEXT_PUBLIC_APP_VERSION (manual override for any platform)
 *   2. CF_PAGES_COMMIT_SHA (Cloudflare Pages)
 *   3. VERCEL_GIT_COMMIT_SHA / NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA (Vercel)
 *   4. Build timestamp fallback
 */
function getBuildVersion(): string {
  return (
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    `build-${Date.now()}`
  )
}

export function GET() {
  return NextResponse.json({
    version: getBuildVersion(),
    builtAt: new Date().toISOString(),
  })
}
