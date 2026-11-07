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
  /** Mean of the last 10 daily closes. Absent when the chart is shorter than that. */
  shortAverage?: number;
}

export type MarketMoodName = "risk-on" | "mixed" | "risk-off";

/** SPY or VIX against its short average. `supportive` is the risk-on side of that average. */
export interface MoodLevel {
  last: number;
  average: number;
  supportive: boolean;
}

export interface MarketMood {
  name: MarketMoodName;
  /** Sessions in the short average. */
  window: number;
  spy: MoodLevel | null;
  vix: MoodLevel | null;
  /** Names on the book whose last print is above their short average. */
  aboveCount: number;
  /** Names that had enough sessions to score. */
  counted: number;
  /** True when more names are above than below. Null on a tie or when none were scored. */
  breadthSupportive: boolean | null;
  /** The inputs, in one sentence. */
  summary: string;
}

export type IndicatorAlignment = "with" | "against";

/** S&P versus its 10-session average. That is the tape the rows line up with. */
export interface IndicatorTape {
  side: "up" | "down";
  last: number;
  average: number;
  relation: "above" | "below" | "equal to";
}

export interface IndicatorRow {
  factor: string;
  period: string;
  statistic: string;
  alignment: IndicatorAlignment;
  /** The way this factor points after its own rule, compared with the S&P tape. */
  points: "up" | "down" | "flat";
}

export interface IndicatorBoard {
  tape: IndicatorTape | null;
  rows: IndicatorRow[];
  /** Series that were requested and did not produce a row. */
  omitted: string[];
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
  /** Live mood from SPY, book breadth, and VIX. Absent on the sample tape or when Yahoo returns none of those inputs. */
  mood?: MarketMood | null;
  /** How public series line up with the S&P tape. Absent on the sample tape. */
  indicators?: IndicatorBoard | null;
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
  /** False when no pattern leaves the target on the correct side of the last price. */
  qualified: boolean;
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
