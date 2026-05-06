import type { MetadataRoute } from "next"

/**
 * Web App Manifest. Drives the PWA install dialog on Chrome / Edge /
 * Brave / Samsung / Safari (iOS 16.4+). Chrome auto-shows its own native
 * install prompt once the engagement heuristics fire; we don't add a
 * banner — there's a small "Install app" link in the dashboard's About
 * fold that triggers the same prompt on demand.
 *
 * Why these fields specifically:
 *   - id pinned so subsequent updates don't accidentally register as a
 *     different installed app
 *   - display "standalone" so the launched app doesn't show browser chrome
 *   - theme_color matches our dark UI background so the mobile splash /
 *     status bar tints correctly
 *   - 'any' icons cover normal launchers; 'maskable' covers Android's
 *     adaptive icon mask so the mark survives circle / squircle clips
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "CYPH / ZEC Tracker",
    short_name: "CYPH/ZEC",
    description:
      "Live $CYPH (Cypherpunk Technologies, NASDAQ) and $ZEC (Zcash) prices, plus the CYPH/ZEC ratio, treasury data, and a portfolio tracker.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    categories: ["finance"],
    lang: "en-US",
    dir: "ltr",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon.svg",
        type: "image/svg+xml",
        sizes: "any",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Portfolio",
        short_name: "Portfolio",
        description: "Track your CYPH and ZEC holdings",
        url: "/portfolio",
      },
      {
        name: "Treasury",
        short_name: "Treasury",
        description: "Cypherpunk's ZEC holdings + transactions",
        url: "/holdings",
      },
      {
        name: "Estimator",
        short_name: "Estimator",
        description: "Predict CYPH for any ZEC price",
        url: "/estimator",
      },
    ],
  }
}
