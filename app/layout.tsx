import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL('https://cyphzec.com'),
  title: 'CYPH / ZEC Price Tracker',
  description: 'Real-time price tracking and ratio chart for $CYPH and $ZEC',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
  openGraph: {
    title: 'CYPH / ZEC Price Tracker',
    description:
      'Live $CYPH (NASDAQ) and $ZEC prices with the CYPH/ZEC ratio. Snapshot refreshes every few hours.',
    url: '/',
    siteName: 'CYPH / ZEC Tracker',
    type: 'website',
    images: [
      {
        url: '/api/og',
        width: 1200,
        height: 630,
        alt: 'Live $CYPH and $ZEC prices and CYPH/ZEC ratio',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CYPH / ZEC Price Tracker',
    description:
      'Live $CYPH and $ZEC prices with the CYPH/ZEC ratio. Updated every few hours.',
    images: ['/api/og'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background">
      <body className="font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
