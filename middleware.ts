import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const CANONICAL_HOST = 'cyphzec.com'

/**
 * Edge middleware:
 *
 *  1. /beta/<path>  →  308 to /<path>
 *     Stale-bookmark cleanup. The cypherpunk-terminal redesign used to
 *     live under /beta/* (and on beta.cyphzec.com as a host-rewrite) so
 *     a small but non-zero amount of inbound traffic still points at
 *     /beta/<route>. 308 preserves link equity for any external sites
 *     that picked up beta URLs during the preview window. Once those
 *     sources have updated this rule can be retired.
 *
 *  2. cyphzec.jiggytom.com → 308 to cyphzec.com
 *     Legacy alias consolidation; preserves link equity on a single
 *     domain.
 *
 *  beta.cyphzec.com is still bound as a Worker route (see
 *  wrangler.jsonc) — it now serves the same routes as cyphzec.com
 *  with no rewrite, so the subdomain acts as a parallel mirror.
 *
 *  File-name note: Next 16 deprecates `middleware.ts` in favor of
 *  `proxy.ts`, but the new convention forces Node.js runtime, which
 *  is incompatible with `@opennextjs/cloudflare` (it errors with
 *  "Node.js middleware is not currently supported"). So we keep this
 *  on the legacy `middleware.ts` convention — it still works in
 *  Next 16, just emits a deprecation warning at build time. Once
 *  OpenNext gains Node-middleware support, this file can be renamed
 *  and the function renamed `proxy()` per the new convention.
 */
export function middleware(request: NextRequest) {
  const host = request.headers.get('host')?.toLowerCase()
  if (!host) return NextResponse.next()

  const url = request.nextUrl

  // 1) Stale beta paths → 308 to the clean equivalent.
  //    `/beta` (exact)            → `/`
  //    `/beta/stats`              → `/stats`
  //    `/beta/holdings/foo`       → `/holdings/foo`
  //    Skip API + internal paths so the redirect can't accidentally
  //    catch routes that legitimately start with `/beta-` or similar
  //    later. We only match `/beta` exactly or `/beta/...`.
  if (
    url.pathname === '/beta' ||
    url.pathname.startsWith('/beta/')
  ) {
    const redirect = url.clone()
    redirect.pathname =
      url.pathname === '/beta' ? '/' : url.pathname.slice('/beta'.length)
    return NextResponse.redirect(redirect, 308)
  }

  // 2) Legacy alias → permanent redirect to canonical.
  if (host === 'cyphzec.jiggytom.com') {
    const redirect = url.clone()
    redirect.host = CANONICAL_HOST
    redirect.protocol = 'https:'
    redirect.port = ''
    return NextResponse.redirect(redirect, 308)
  }

  const response = NextResponse.next()
  if (shouldNoStoreAppShell(request)) {
    response.headers.set(
      'Cache-Control',
      'private, no-cache, no-store, max-age=0, must-revalidate'
    )
  }
  return response
}

function shouldNoStoreAppShell(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.ico')
  ) {
    return false
  }

  const accept = request.headers.get('accept') ?? ''
  return (
    request.headers.get('rsc') === '1' ||
    request.headers.has('next-router-state-tree') ||
    request.headers.has('next-router-prefetch') ||
    accept.includes('text/html')
  )
}

export const config = {
  // Skip Next internals + static asset paths so the proxy doesn't
  // run for every chunk request, but crawlers, social-preview scrapers,
  // the API routes, and the OG image still go through it (they need
  // to resolve to the canonical host).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
