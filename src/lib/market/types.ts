export type Side = "long" | "short";

export type Stance = "consider" | "stand-aside";

export type Sentiment = "positive" | "negative" | "mixed" | "neutral";

export type PatternName =
  | "Bull flag"
  | "Bear flag"
  | "Double top"
  | "Double bottom"
  | "Head and shoulders"
  | "Inverse head and shoulders"
  | "Cup and handle"
  | "Breakout"
  | "Breakdown"
  | "Opening-range break";

export type PatternStatus = "triggered" | "forming" | "failed";

export type VwapEvent =
  | "reclaim"
  | "reject"
  | "holding-above"
  | "holding-below"
  | "chop";

export type OpeningRangeEvent = "break-up" | "break-down" | "inside";

export type Alignment = "aligned" | "opposed" | "mixed" | "neutral" | "flat" | "chop" | "inside";

export interface NewsPillar {
  catalyst: string;
  headline: string;
  source: string;
  publishedAt: string;
  sentiment: Sentiment;
}

export interface EarningsPillar {
  period: string;
  reportedAt: string;
  /** Whole dollars. Zero when the source did not publish revenue. */
  revenueActual: number;
  /** Whole dollars. Null when the source has no revenue consensus for that print. */
  revenueEstimate: number | null;
  epsActual?: number | null;
  epsEstimate?: number | null;
  /**
   * Which print the surprise rule uses. Sample data leaves this unset and
   * the engine scores revenue versus estimate.
   */
  surpriseBasis?: "revenue" | "eps";
  /** Trading sessions since the report. 0 means this session. */
  recencySessions: number;
}

export interface PatternPillar {
  name: PatternName;
  bias: "bullish" | "bearish";
  status: PatternStatus;
  /** Price that breaks the pattern. Context only — the order stop is ATR. */
  invalidation: number;
  note: string;
}

/** One symbol on the session tape. Live adapters should return this same shape. */
export interface Snapshot {
  symbol: string;
  name: string;
  last: number;
  vwap: number;
  vwapEvent: VwapEvent;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeEvent: OpeningRangeEvent;
  /** ATR in dollars. Daily patterns use a daily ATR; an opening-range break uses 5-minute ATR. */
  atr: number;
  atrTimeframe?: "5-minute" | "daily";
  /** Today's volume divided by the average volume at this time of day. */
  relativeVolume: number;
  /** Pattern measured-move target. The engine checks it against the minimum reward:risk. */
  measuredTarget: number;
  news: NewsPillar;
  earnings: EarningsPillar;
  pattern: PatternPillar;
}

export interface SessionNote {
  title: string;
  detail: string;
}

export interface MarketSession {
  asOf: string;
  market: string;
  source: "sample" | "live";
  /** Who produced the quotes, in plain language. */
  feed: string;
  /** Delay and as-of line shown on the book. */
  delayLabel: string;
  /** Set when live quotes failed and the sample tape is on screen instead. */
  fallbackError?: string;
  note: SessionNote;
  snapshots: Snapshot[];
}

export interface RiskSettings {
  accountSize: number;
  /** Percent of account, so 0.5 means half of one percent. */
  maxRiskPct: number;
  /** 2 means 2:1. */
  minRewardRisk: number;
}

export const DEFAULT_RISK: RiskSettings = {
  accountSize: 25_000,
  maxRiskPct: 0.5,
  minRewardRisk: 2,
};

export interface TradeIdea {
  symbol: string;
  name: string;
  side: Side;
  stance: Stance;
  rank: number;
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
  riskReward: number;
  clearsMinimumReward: boolean;
  confidence: number;
  reasons: string[];
  conflicts: string[];
  suggestedShares: number;
  /** Shares the budget would buy if the idea were still a consider. */
  indicatedShares: number;
  riskPerShare: number;
  riskDollars: number;
  riskBudget: number;
  notional: number;
  accountSize: number;
  maxRiskPct: number;
  minRewardRisk: number;
  news: NewsPillar;
  earnings: EarningsPillar;
  earningsSurprisePct: number;
  earningsSurpriseBasis: "revenue" | "eps";
  atrTimeframe?: "5-minute" | "daily";
  pattern: PatternPillar;
  relativeVolume: number;
  vwap: number;
  vwapEvent: VwapEvent;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeEvent: OpeningRangeEvent;
  atr: number;
  last: number;
  newsAlignment: "aligned" | "opposed" | "mixed" | "neutral";
  earningsAlignment: "aligned" | "opposed" | "flat";
  earningsAge: "fresh" | "recent" | "stale";
  vwapAlignment: "aligned" | "opposed" | "chop";
  openingRangeAlignment: "aligned" | "opposed" | "inside";
}
