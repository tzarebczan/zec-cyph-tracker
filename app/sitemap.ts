import type { MetadataRoute } from 'next'

const SITE_URL = 'https://cyphzec.com'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 1.0,
    },
  ]
}
