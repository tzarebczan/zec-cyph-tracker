import type { MetadataRoute } from 'next'

const SITE_URL = 'https://cyphzec.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/about`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/estimator`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
  ]
}
