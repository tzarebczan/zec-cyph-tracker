import { PriceDashboard } from "@/components/price-dashboard"
import { SeoContent } from "@/components/seo-content"

export default function Home() {
  return (
    <>
      <PriceDashboard />
      {/* Server-rendered prose for crawlers — GSC shows the homepage
          earns almost all impressions but had almost no indexable text
          beyond the live dashboard. */}
      <div className="max-w-6xl mx-auto px-3 pb-8">
        <SeoContent />
      </div>
    </>
  )
}
