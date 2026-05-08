import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const CANONICAL_HOST = 'cyphzec.com'

/**
 * 301-redirect every request that lands on a non-canonical host to the
 * canonical one (cyphzec.com). This consolidates link equity / search
 * ranking onto a single domain. Both cyphzec.com and the legacy
 * cyphzec.jiggytom.com are bound as custom domains on the worker, so
 * without a redirect Google would index the same content twice.
 *
 * Use 308 (Permanent Redirect) — it preserves the request method and
 * tells search engines the move is permanent.
 */
export function middleware(request: NextRequest) {
  const host = request.headers.get('host')?.toLowerCase()
  if (!host || host === CANONICAL_HOST) return NextResponse.next()

  // Don't redirect localhost / Workers preview URLs etc. — only redirect
  // hosts we know are aliases for the canonical domain.
  const isLegacyAlias = host === 'cyphzec.jiggytom.com'
  if (!isLegacyAlias) return NextResponse.next()

  const url = new URL(request.url)
  url.host = CANONICAL_HOST
  url.protocol = 'https:'
  url.port = ''
  return NextResponse.redirect(url, 308)
}

export const config = {
  // Skip Next internals + static asset paths to keep the middleware cheap.
  // Crawlers, social-preview scrapers, and the OG image all still go
  // through it — they should resolve to the canonical host too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
