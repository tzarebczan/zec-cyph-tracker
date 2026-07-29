export const IRONWOOD_ACTIVATION_HEIGHT = 3_428_143
export const IRONWOOD_ACTIVATION_TIME = "2026-07-28T14:07:23Z"

export interface IronwoodPoolSizes {
  orchardZec: number
  ironwoodZec: number
  sproutZec: number
  saplingZec: number
  transparentZec: number
  shieldedTotalZec: number
  chainSupplyZec: number
  updatedAt: string | null
  sourceHeight: number
  isLive: boolean
}

export interface IronwoodMigrationOverview {
  totalMigratedZec: number
  txCount: number
  firstHeight: number | null
  lastHeight: number | null
  migratedPercent: number
  velocityZecPerHour: number
}

export interface IronwoodInflowSources {
  fromOrchardZec: number
  fromOrchardTxs: number
  fromSaplingZec: number
  fromSaplingTxs: number
  fromTransparentZec: number
  fromTransparentTxs: number
  fromCoinbaseZec: number
  fromCoinbaseTxs: number
  totalInZec: number
  totalOutZec: number
}

export interface IronwoodSupplyAudit {
  orchardOutZec: number
  coinbaseInZec: number
  ironwoodInZec: number
  ironwoodOutZec: number
  indexedNetZec: number
  authoritativePoolZec: number
  differenceZec: number
  accountingHeight: number
  sourceHeight: number
  status: "balanced" | "syncing" | "mismatch" | "stale" | string
  balanced: boolean | null
}

export interface IronwoodSupplyVerification {
  chainSupplyZec: number
  verifiedZec: number
  unverifiedZec: number
  verifiedPct: number
}

export interface IronwoodLiveOverview {
  activationHeight: number
  tipHeight: number
  activated: boolean
  avgBlockTimeSecs: number
  blocksUntilActivation: number
  estimatedActivationAt: number | null
  poolSizes: IronwoodPoolSizes
  migration: IronwoodMigrationOverview
  inflowSources: IronwoodInflowSources
  supplyAudit: IronwoodSupplyAudit
  supplyVerification: IronwoodSupplyVerification | null
}

export interface IronwoodBlock {
  height: number
  hash: string
  timestamp: number
  txCount: number
  size: number
  feesZec: number
  minerRewardZec: number
}

export interface IronwoodMempoolTx {
  txid: string
  size: number
  timestamp: number
  type: string
  vin: number
  vout: number
  orchardActions: number
  ironwoodActions: number
  orchardOutZec: number
  ironwoodInZec: number
}

export interface IronwoodMigrationTx {
  txid: string
  height: number
  timestamp: number | null
  amountZec: number
  orchardOutZec: number
  isCoinbase: boolean
  privacy: "denominated" | "distinctive"
  matchedDenomination: number | null
}

export interface IronwoodCohort {
  boundary: number
  boundaryStartHeight: number
  txCount: number
  volumeZec: number
  firstTime: number | null
  ironwoodPoolZec: number | null
  orchardOutflowZec: number | null
}

export interface IronwoodDenominationBin {
  power: number
  denomination: number
  label: string
  txCount: number
  volumeZec: number
}

export interface IronwoodAnalytics {
  total: number
  denominatedCount: number
  distinctiveCount: number
  denominatedPercent: number
  denominatedVolumeZec: number
  distinctiveVolumeZec: number
  transactions: IronwoodMigrationTx[]
  cohortCount: number
  boundaryModulus: number
  avgAnonymitySet: number
  minAnonymitySet: number
  maxAnonymitySet: number
  cohorts: IronwoodCohort[]
  denominations: IronwoodDenominationBin[]
}

export interface IronwoodLiveResponse {
  success: true
  overview: IronwoodLiveOverview
  blocks: IronwoodBlock[]
  mempool: {
    totalCount: number
    migrationCount: number
    migrationVolumeZec: number
    transactions: IronwoodMempoolTx[]
  }
  analytics: IronwoodAnalytics
  liveFetchedAt: number
  analyticsFetchedAt: number | null
  fetchedAt: number
  stale?: boolean
  errors?: string[]
}

export interface IronwoodTxDetail {
  txid: string
  blockHeight: number | null
  blockTime: number | null
  confirmations: number | null
  size: number
  version: number
  feeZec: number
  vinCount: number
  voutCount: number
  orchardActions: number
  ironwoodActions: number
  orchardValueBalanceZec: number
  ironwoodValueBalanceZec: number
  hasOrchard: boolean
  hasIronwood: boolean
  isCoinbase: boolean
  isCanonical: boolean | null
}
