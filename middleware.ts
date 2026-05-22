import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const CANONICAL_HOST = 'cyphzec.com'
const BETA_HOST = 'beta.cyphzec.com'
// Hosts that should serve the redesigned UI. The Next routes for the
// new design live under /beta/*, but users on beta.cyphzec.com should
// see clean URLs (/, /portfolio, /stats, …), so we *rewrite* the
// request path internally instead of redirecting. Same content from
// the same worker — just a different mapping of host -> internal path.
const BETA_HOSTS = new Set<string>([
  BETA_HOST,
  // Cloudflare workers.dev preview alias, in case beta is bound there
  // for staging too. Adding it here is a no-op when the alias is not
  // registered as a custom domain.
])

// Top-level files Next auto-generates at the site root. Listed here so
// the beta-host rewrite leaves them alone — /sitemap.xml on
// beta.cyphzec.com should resolve to the canonical sitemap, not to a
// non-existent /beta/sitemap.xml.
const METADATA_PATHS = new Set<string>([
  '/manifest.webmanifest',
  '/sitemap.xml',
  '/robots.txt',
  '/favicon.ico',
])
function isMetadataPath(pathname: string): boolean {
  if (METADATA_PATHS.has(pathname)) return true
  // Icons / OG images live at the root too (icon-light-32x32.png,
  // apple-icon.png, …). They're served as static assets by Next.
  if (/^\/(icon|apple-icon)(-|\.|$)/.test(pathname)) return true
  return false
}

/**
 * Host-aware middleware:
 *
 *  1. beta.cyphzec.com/<path>  →  internally serve /beta/<path>
 *     (so the redesign is the *whole* site at the beta subdomain
 *     without users seeing the /beta prefix in the URL bar).
 *
 *  2. cyphzec.jiggytom.com → 308 to cyphzec.com (legacy alias
 *     consolidation; preserves link equity on a single domain).
 *
 *  3. Anyone hitting /beta/* directly on cyphzec.com still sees the
 *     redesign — that path is intentionally left navigable so the
 *     team can review the beta on the canonical host without a DNS
 *     change. When the redesign is ready for the main site, swap the
 *     `rewrite` block: instead of beta-host -> /beta, point
 *     cyphzec.com itself at /beta. That's a one-line change here.
 */
export function middleware(request: NextRequest) {
  const host = request.headers.get('host')?.toLowerCase()
  if (!host) return NextResponse.next()

  const url = request.nextUrl

  // 1) Beta host → rewrite onto the /beta route tree.
  //    Skip paths that should resolve at the root regardless of host:
  //    - /api/*       — JSON endpoints; the dashboard fetches /api/quote,
  //                     /api/prices, etc. from the same origin and they
  //                     are not duplicated under /beta.
  //    - /_next/*     — Next.js build assets / RSC payloads.
  //    - top-level metadata routes (manifest, sitemap, robots, icons,
  //                     favicon) — Next auto-emits these at the root.
  if (BETA_HOSTS.has(host)) {
    if (
      url.pathname.startsWith('/beta') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/_next/') ||
      isMetadataPath(url.pathname)
    ) {
      return NextResponse.next()
    }
    const rewritten = url.clone()
    rewritten.pathname =
      url.pathname === '/' ? '/beta' : `/beta${url.pathname}`
    return NextResponse.rewrite(rewritten)
  }

  // 2) Legacy alias → permanent redirect to canonical.
  if (host === 'cyphzec.jiggytom.com') {
    const redirect = url.clone()
    redirect.host = CANONICAL_HOST
    redirect.protocol = 'https:'
    redirect.port = ''
    return NextResponse.redirect(redirect, 308)
  }

  return NextResponse.next()
}

export const config = {
  // Skip Next internals + static asset paths so the middleware doesn't
  // run for every chunk request, but crawlers, social-preview scrapers,
  // the API routes, and the OG image still go through it (they need
  // to resolve to the canonical host / get rewritten to /beta).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
