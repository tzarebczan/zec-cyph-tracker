/** @type {import('next').NextConfig} */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"

function getBuildVersion() {
  // Prefer explicit deployment IDs, then git SHA, then a hash of the
  // build environment. This gives every build a stable identifier without
  // relying on platform env vars that may not reach the client bundle.
  const explicit =
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.NEXT_DEPLOYMENT_ID ||
    process.env.WORKERS_CI_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ""
  if (explicit) return explicit.trim().slice(0, 40)

  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim().slice(0, 40)
  } catch {
    // Not in a git repo or git unavailable — fall back to a hash of the
    // current time + node version so builds still get distinct versions.
    return createHash("sha256")
      .update(`${Date.now()}-${process.version}-${process.platform}`)
      .digest("hex")
      .slice(0, 16)
  }
}

const BUILD_VERSION = getBuildVersion()

const rawDeploymentId =
  process.env.NEXT_DEPLOYMENT_ID ||
  process.env.WORKERS_CI_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  ""
const deploymentId = rawDeploymentId
  .replace(/[^a-zA-Z0-9_-]/g, "")
  .slice(0, 40)

const nextConfig = {
  ...(deploymentId ? { deploymentId } : {}),
  env: {
    NEXT_PUBLIC_BUILD_VERSION: BUILD_VERSION,
  },
  outputFileTracingRoot: process.cwd(),
  turbopack: {
    root: process.cwd(),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
    ]
  },
  // Required for the OpenNext / Cloudflare bundle:
  // - `output: 'standalone'` makes Next emit pages-manifest.json + the
  //   minimal node_modules subset that OpenNext re-bundles into the worker
  // - we drive the build via the `--webpack` flag (in package.json scripts)
  //   instead of Turbopack, because Turbopack doesn't emit the .nft.json
  //   traces that OpenNext uses to detect / patch @vercel/og's WASM
  output: "standalone",
}

// Wire up @opennextjs/cloudflare's dev hooks so `next dev` keeps working
// against the Cloudflare bindings (KV, R2, D1, etc.) once any are added.
if (process.env.NODE_ENV === "development") {
  await import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) =>
    initOpenNextCloudflareForDev()
  )
}

export default nextConfig
