import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const _geist = Geist({ subsets: ['latin'] })
const _geistMono = Geist_Mono({ subsets: ['latin'] })

const SITE_URL = 'https://cyphzec.com'
const SITE_NAME = 'CYPH / ZEC Tracker'
// Title balances the two keyword pairs Google treats as distinct:
//   - CYPH ↔ Cypherpunk (Technologies / Holdings)
//   - ZEC  ↔ Zcash
// "Stock" reinforces that this is the equity, not the various
// other CYPH-named projects on Google. Keeping "CYPH/ZEC" in the
// title preserves the existing first-page ranking for that phrase.
const TITLE =
  'CYPH Stock & Zcash (ZEC) Price — Cypherpunk Technologies / Zcash Tracker'
const DESCRIPTION =
  'Live $CYPH stock price (Cypherpunk Technologies, NASDAQ) and $ZEC / Zcash price, plus the CYPH/ZEC ratio. Pre-market, after-hours, and overnight Blue Ocean ATS sessions, with 7d / 30d / 90d performance and a historical chart back to Nov 12 2025.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: '%s | CYPH / ZEC Tracker',
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  generator: 'Next.js',
  keywords: [
    // CYPH side
    'CYPH',
    'CYPH stock',
    'CYPH stock price',
    'CYPH price',
    'NASDAQ CYPH',
    'Cypherpunk',
    'Cypherpunk stock',
    'Cypherpunk price',
    'Cypherpunk Technologies',
    'Cypherpunk Technologies stock',
    'Cypherpunk Technologies price',
    'Cypherpunk Holdings',
    'Cypherpunk Holdings stock',
    // ZEC / Zcash side
    'ZEC',
    'ZEC price',
    'Zcash',
    'Zcash price',
    'Zcash ZEC',
    // Combined
    'CYPH ZEC',
    'CYPH ZEC price',
    'CYPH ZEC ratio',
    'CYPH Zcash',
    'CYPH Zcash price',
    'Cypherpunk Zcash',
    'Cypherpunk Zcash ratio',
    'CYPH/ZEC',
    // Sessions
    'CYPH overnight',
    'CYPH after hours',
    'Blue Ocean ATS',
  ],
  alternates: {
    canonical: SITE_URL,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    type: 'website',
    locale: 'en_US',
    images: [
      {
        url: '/api/og',
        width: 1200,
        height: 630,
        alt: 'Live CYPH (Cypherpunk Technologies) stock price and ZEC (Zcash) price with the CYPH/ZEC ratio',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/api/og'],
  },
  category: 'finance',
  // Google Search Console ownership verification. The same token is also
  // present as a TXT record on the cyphzec.com zone — having both means
  // Search Console can verify via either method, and the property stays
  // verified if one channel is later removed.
  verification: {
    google: 'Aq7O1o3bNiYp4pkGcoUTOuaFVoxTwKqCm5NSt1_i_Ig',
  },
}

export const viewport = {
  themeColor: '#0b0f14',
  colorScheme: 'dark' as const,
}

// Schema.org structured data (site-wide). WebSite describes the property
// itself; WebPage describes the dashboard at the root URL. The FAQPage
// schema lives on /about — its dedicated page — because Google requires
// FAQ structured data to live on the URL where the FAQ is actually
// rendered.
const jsonLd = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}#website`,
    url: SITE_URL,
    name: SITE_NAME,
    description: DESCRIPTION,
    inLanguage: 'en-US',
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon.svg` },
    },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${SITE_URL}#webpage`,
    url: SITE_URL,
    name: TITLE,
    description: DESCRIPTION,
    isPartOf: { '@id': `${SITE_URL}#website` },
    primaryImageOfPage: { '@id': `${SITE_URL}/api/og` },
    about: [
      {
        '@type': 'Corporation',
        name: 'Cypherpunk Technologies Inc.',
        // Google uses alternateName as a synonym hint for entity matching —
        // tells it that queries for any of these names should map to the
        // same Corporation entity this page is about.
        alternateName: [
          'Cypherpunk Technologies',
          'Cypherpunk Holdings',
          'Cypherpunk',
          'CYPH',
        ],
        tickerSymbol: 'CYPH',
        url: 'https://www.cypherpunkholdings.com/',
      },
      {
        '@type': 'Thing',
        name: 'Zcash',
        alternateName: ['ZEC', '$ZEC', 'Zcash cryptocurrency'],
        url: 'https://z.cash/',
      },
    ],
  },
]

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background">
      <body className="font-sans antialiased">
        {children}
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
