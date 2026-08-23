export type Venue = "polymarket" | "jupiter";
export type Asset = "BTC" | "ETH" | "SOL" | "XRP";
export type Comparison = "GT" | "GTE" | "LT" | "LTE" | "UNKNOWN";
export type ObservationMode = "POINT" | "TOUCH" | "RANGE" | "UNKNOWN";
export type WindowAnchor =
  | "POINT"
  | "MARKET_CREATION"
  | "CALENDAR_MONTH"
  | "EXPLICIT_PERIOD"
  | "UNKNOWN";

export interface MarketPricing {
  buyYesMicroUsd: bigint | null;
  sellYesMicroUsd: bigint | null;
  buyNoMicroUsd: bigint | null;
  sellNoMicroUsd: bigint | null;
}

export interface MarketFeeSchedule {
  rate: string;
  exponent: number;
  takerOnly: boolean;
}

export interface VenueMarket {
  venue: Venue;
  provider: string;
  eventId: string | null;
  marketId: string;
  title: string;
  eventTitle: string;
  rulesPrimary: string;
  rulesSecondary: string;
  status: string;
  openTimeMs: number | null;
  closeTimeMs: number | null;
  clobTokenIds: readonly string[];
  outcomes: readonly string[];
  /** Token mint for directly tradable outcomes such as Jupiter Forecast. */
  outcomeMint?: string | null;
  pricing: MarketPricing;
  feeSchedule?: MarketFeeSchedule;
  sourceUrl: string;
}

export interface CanonicalRule {
  asset: Asset | null;
  thresholdMicroUsd: bigint | null;
  comparison: Comparison;
  observationMode: ObservationMode;
  windowAnchor: WindowAnchor;
  openTimeMs: number | null;
  closeTimeMs: number | null;
  oracle: string | null;
  sampling: string | null;
  timezone: string | null;
  ruleHash: string;
  complete: boolean;
}

export interface BookLevel {
  priceMicroUsd: bigint;
  contractsMicro: bigint;
  /** True when priceMicroUsd is already an all-in executable price. */
  takerFeeIncluded?: boolean;
}

export interface SideOrderBook {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}

export interface BinaryOrderBook {
  venue: Venue;
  provider: string;
  marketId: string;
  receivedAtMs: number;
  sourceTimestampMs: number | null;
  yes: SideOrderBook;
  no: SideOrderBook;
}

export type MatchVerdict =
  | "EXACT"
  | "REVIEW_REQUIRED"
  | "SHARED_LIQUIDITY"
  | "BASIS"
  | "REJECT";

export interface MarketMatch {
  polymarket: VenueMarket;
  jupiter: VenueMarket;
  polyRule: CanonicalRule;
  jupiterRule: CanonicalRule;
  verdict: MatchVerdict;
  score: number;
  reasons: readonly string[];
  sharedTokenIds: readonly string[];
}
