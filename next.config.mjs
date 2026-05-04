/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

// Wire up @opennextjs/cloudflare's dev hooks so `next dev` keeps working
// against the Cloudflare bindings (KV, R2, D1, etc.) once any are added.
if (process.env.NODE_ENV === "development") {
  await import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) =>
    initOpenNextCloudflareForDev()
  )
}

export default nextConfig
