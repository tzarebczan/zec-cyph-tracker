/* eslint-disable */
// Minimal service worker for PWA installability + offline shell.
//
// Strategy:
//   - Static assets (icons, _next/static/*): cache-first. Versioned URLs
//     so stale cache hits are safe.
//   - Document navigations (/, /portfolio, /about, etc.): network-first
//     with cache fallback so users always see fresh prices when online,
//     but the app shell still loads when offline.
//   - JSON API calls (/api/*): network-only — we never want to serve a
//     stale price from the SW. Server-side caching already handles burst
//     load, and dashboards displaying yesterday's quote would be worse
//     than showing the existing in-app "Cached" / "Retrying" indicators.
//
// We bump CACHE_VERSION whenever the SW logic changes — old caches get
// pruned on activate so users don't end up serving multi-deploy-old
// chunks.

const CACHE_VERSION = "v3"
const STATIC_CACHE = `cyphzec-static-${CACHE_VERSION}`
const PAGES_CACHE = `cyphzec-pages-${CACHE_VERSION}`

// Pre-cache the bare minimum needed to render the app shell offline.
const PRECACHE_URLS = [
  "/",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      // Best-effort precache — partial failure is fine, the SW still
      // installs and individual misses can be filled lazily on first hit.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url)
          } catch {}
        })
      )
      // Activate immediately on update so users get the new SW logic
      // without having to close every tab.
      await self.skipWaiting()
    })()
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter(
            (k) =>
              k.startsWith("cyphzec-") &&
              k !== STATIC_CACHE &&
              k !== PAGES_CACHE
          )
          .map((k) => caches.delete(k))
      )
      await self.clients.claim()
    })()
  )
})

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/favicon.ico" ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/apple-icon.png"
  )
}

function isApiRequest(url) {
  return url.pathname.startsWith("/api/")
}

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return
  const url = new URL(req.url)
  // Only handle same-origin requests; let the browser deal with the rest.
  if (url.origin !== self.location.origin) return

  // API: don't cache. Always go to the network so the dashboard never
  // displays a stale price the SW served behind the user's back.
  if (isApiRequest(url)) return

  // Static assets: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      })()
    )
    return
  }

  // Navigations / HTML: network-first with cache fallback.
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req, { cache: "no-store" })
          if (res.ok) {
            const cache = await caches.open(PAGES_CACHE)
            cache.put(req, res.clone())
          }
          return res
        } catch {
          // Offline. Serve cached version of the page if we have one,
          // else fall back to the cached "/" app shell.
          const cache = await caches.open(PAGES_CACHE)
          const hit = await cache.match(req)
          if (hit) return hit
          const shell = await caches.match("/")
          if (shell) return shell
          throw new Error("offline and no cached fallback")
        }
      })()
    )
  }
})
