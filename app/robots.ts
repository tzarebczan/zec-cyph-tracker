import type { MetadataRoute } from 'next'

const SITE_URL = 'https://cyphzec.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/api/og'],
        // Machine-only JSON endpoints — let crawlers focus their budget
        // on the indexable HTML and the OG image used for social previews.
        // /beta is the redesign preview; it's noindex via metadata, but
        // we also explicitly disallow crawling here so the canonical
        // host doesn't accidentally surface the duplicate routes.
        disallow: ['/api/quote', '/api/prices', '/beta', '/beta/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
