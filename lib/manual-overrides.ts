import raw from "./manual-overrides.json"

// Hand-entered corrections layered over automated feeds (Yahoo analyst
// history, SEC EDGAR share counts). Edit manual-overrides.json and deploy.

export type OverrideAction = "upgrade" | "downgrade" | "initiate" | "maintain" | "reiterate"

export interface RatingOverride {
  /** YYYY-MM-DD, UTC. */
  date: string
  firm: string
  action?: OverrideAction
  fromGrade?: string | null
  toGrade?: string | null
  priceTarget?: number | null
  priorPriceTarget?: number | null
}

export interface SharesOverride {
  value: number
  /** YYYY-MM-DD the count is as of. */
  asOf: string
}

interface OverridesFile {
  ratings?: RatingOverride[]
  sharesOutstanding?: SharesOverride | null
}

const overrides = raw as OverridesFile

export const RATING_OVERRIDES: RatingOverride[] = (overrides.ratings ?? []).filter(
  (r) => r && r.firm && Number.isFinite(Date.parse(r.date))
)

export const SHARES_OVERRIDE: SharesOverride | null =
  overrides.sharesOutstanding &&
  Number.isFinite(overrides.sharesOutstanding.value) &&
  overrides.sharesOutstanding.value > 0 &&
  Number.isFinite(Date.parse(overrides.sharesOutstanding.asOf))
    ? overrides.sharesOutstanding
    : null
