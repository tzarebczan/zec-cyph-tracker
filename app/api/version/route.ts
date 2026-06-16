import { NextResponse } from "next/server"

/**
 * Expose the current build version so the client can detect when a new
 * deployment has happened and prompt the user to refresh.
 *
 * NEXT_PUBLIC_BUILD_VERSION is generated at build time in next.config.mjs
 * (git SHA by default, or an explicit deployment id / app version).
 */
export function GET() {
  return NextResponse.json({
    version: process.env.NEXT_PUBLIC_BUILD_VERSION || "unknown",
    builtAt: new Date().toISOString(),
  })
}
