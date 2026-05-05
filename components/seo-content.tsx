/**
 * Indexable text content for SEO. Server-rendered (no "use client"), so the
 * full prose is in the initial HTML response — Google indexes this directly
 * without needing JS execution. Sits below the dashboard so it doesn't
 * compete with the prices for above-the-fold real estate.
 *
 * Heading hierarchy: dashboard h1 ("$CYPH / $ZEC") → these h2s. Content is
 * worded around the actual queries we want to rank for ("CYPH ZEC ratio",
 * "Cypherpunk Technologies stock", "CYPH overnight", etc.) without keyword-
 * stuffing — clear, factual, useful for actual humans who land on the page.
 */
export function SeoContent() {
  return (
    <section
      aria-labelledby="about-heading"
      className="rounded-lg border border-border bg-card p-4 md:p-6 flex flex-col gap-6"
    >
      <div className="flex flex-col gap-3">
        <h2
          id="about-heading"
          className="text-base md:text-lg font-mono font-bold text-foreground"
        >
          About the CYPH / ZEC Ratio
        </h2>
        <div className="text-sm text-muted-foreground leading-relaxed flex flex-col gap-3">
          <p>
            <strong className="text-foreground">$CYPH</strong> is the NASDAQ
            ticker for{' '}
            <a
              href="https://www.cypherpunkholdings.com/"
              rel="noopener noreferrer"
              target="_blank"
              className="text-primary underline-offset-2 hover:underline"
            >
              Cypherpunk Technologies Inc.
            </a>
            , a publicly-traded company that began holding{' '}
            <strong className="text-foreground">$ZEC</strong> (
            <a
              href="https://z.cash/"
              rel="noopener noreferrer"
              target="_blank"
              className="text-primary underline-offset-2 hover:underline"
            >
              Zcash
            </a>
            ) on its balance sheet on{' '}
            <time dateTime="2025-11-12">November 12, 2025</time>. The CYPH/ZEC
            ratio measures the company&rsquo;s share price relative to the
            spot price of one Zcash coin, so you can see at a glance whether
            the stock is trading at a premium or a discount versus its
            underlying ZEC reserves.
          </p>
          <p>
            Quotes refresh every 30 to 60 seconds during market hours.{' '}
            <strong className="text-foreground">CYPH</strong> data — including
            the regular NASDAQ session, pre-market, after-hours, and the
            overnight Blue Ocean ATS session — comes from Yahoo Finance.{' '}
            <strong className="text-foreground">ZEC</strong> spot price comes
            from Kraken&rsquo;s public API. The historical chart goes back to
            November 12, 2025 — the day CYPH first started accumulating ZEC.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-base md:text-lg font-mono font-bold text-foreground">
          Frequently Asked Questions
        </h2>
        <dl className="flex flex-col gap-4 text-sm leading-relaxed">
          <div>
            <dt className="font-semibold text-foreground">
              What does the CYPH/ZEC ratio actually represent?
            </dt>
            <dd className="text-muted-foreground mt-1">
              It&rsquo;s the price of one CYPH share divided by the price of
              one ZEC coin. Since Cypherpunk Technologies holds ZEC on its
              balance sheet, the ratio is a quick proxy for how the market
              prices CYPH versus its crypto treasury. A rising ratio means
              CYPH is outperforming ZEC; a falling ratio means ZEC is
              outperforming CYPH.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">
              Why does CYPH show overnight prices when other stock trackers don&rsquo;t?
            </dt>
            <dd className="text-muted-foreground mt-1">
              CYPH trades on the Blue Ocean ATS overnight session — roughly
              8 PM to 4 AM ET, Sunday through Thursday — alongside other
              CYPH cypherpunk holders. This tracker pulls the latest overnight tick
              alongside the regular session close so you can see how the
              stock has moved while the main market was shut.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">
              How often does this page update?
            </dt>
            <dd className="text-muted-foreground mt-1">
              The dashboard auto-refreshes every 30 seconds for the live CYPH
              quote and every 60 seconds for ZEC and the historical chart.
              Stale data is preserved on the backend for up to 6 hours so a
              brief upstream outage doesn&rsquo;t leave the page blank.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">
              Is cyphzec.com affiliated with Cypherpunk Technologies or Zcash?
            </dt>
            <dd className="text-muted-foreground mt-1">
              No. This is an independent tracker built by an enthusiast. It is
              not affiliated with, endorsed by, or sponsored by Cypherpunk
              Technologies Inc., the Electric Coin Company, or the Zcash
              Foundation. Nothing on this page is investment advice.
            </dd>
          </div>
        </dl>
      </div>

      <p className="text-xs text-muted-foreground/70 pt-2 border-t border-border/40">
        $CYPH (NASDAQ) via Yahoo Finance · $ZEC via Kraken · all times UTC unless otherwise noted.
      </p>
    </section>
  )
}
