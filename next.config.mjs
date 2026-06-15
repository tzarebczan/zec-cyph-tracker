/** @type {import('next').NextConfig} */
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
