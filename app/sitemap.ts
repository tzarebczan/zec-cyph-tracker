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
      url: `${SITE_URL}/updates`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.65,
    },
    {
      url: `${SITE_URL}/estimator`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/portfolio`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/holdings`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.85,
    },
    {
      url: `${SITE_URL}/stats`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.85,
    },
    {
      url: `${SITE_URL}/ironwood`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.85,
    },
    {
      url: `${SITE_URL}/bitcoin`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/shielding`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/shielding/unshieldings`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.75,
    },
    {
      url: `${SITE_URL}/orchard-risk`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.75,
    },
    {
      url: `${SITE_URL}/exchanges`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
  ]
}
