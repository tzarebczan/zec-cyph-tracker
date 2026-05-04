/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
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
