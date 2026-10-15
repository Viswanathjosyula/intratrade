import type {
  EarningsPillar,
  OpeningRangeEvent,
  RiskSettings,
  Sentiment,
  Side,
  Snapshot,
  TradeIdea,
  VwapEvent,
} from "./types";

const ENTRY_BAND = 0.12;
const FRESH_SESSIONS = 5;
const RECENT_SESSIONS = 20;

export function surprisePct(actual: number, estimate: number): number {
  if (!Number.isFinite(estimate) || estimate === 0) return 0;
  return ((actual - estimate) / Math.abs(estimate)) * 100;
}

export function earningsSurpriseOf(earnings: EarningsPillar): {
  pct: number;
  basis: "revenue" | "eps";
} {
  if (
    earnings.surpriseBasis === "eps" &&
    typeof earnings.epsActual === "number" &&
    typeof earnings.epsEstimate === "number" &&
    earnings.epsEstimate !== 0
  ) {
    return { pct: surprisePct(earnings.epsActual, earnings.epsEstimate), basis: "eps" };
  }
  if (typeof earnings.revenueEstimate === "number" && earnings.revenueEstimate !== 0) {
    return {
      pct: surprisePct(earnings.revenueActual, earnings.revenueEstimate),
      basis: "revenue",
    };
  }
  return { pct: 0, basis: "revenue" };
}

export function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

function earningsAge(sessions: number): TradeIdea["earningsAge"] {
  if (sessions <= FRESH_SESSIONS) return "fresh";
  if (sessions <= RECENT_SESSIONS) return "recent";
  return "stale";
}

function newsAlignment(
  side: Side,
  sentiment: Sentiment,
): TradeIdea["newsAlignment"] {
  if (sentiment === "mixed") return "mixed";
  if (sentiment === "neutral") return "neutral";
  if (side === "long" && sentiment === "positive") return "aligned";
  if (side === "short" && sentiment === "negative") return "aligned";
  return "opposed";
}

function earningsAlignment(
  side: Side,
  surprise: number,
): TradeIdea["earningsAlignment"] {
  if (Math.abs(surprise) < 1) return "flat";
  if (side === "long" && surprise > 0) return "aligned";
  if (side === "short" && surprise < 0) return "aligned";
  return "opposed";
}

function vwapAlignment(side: Side, event: VwapEvent): TradeIdea["vwapAlignment"] {
  if (event === "chop") return "chop";
  const bullish = event === "reclaim" || event === "holding-above";
  const bearish = event === "reject" || event === "holding-below";
  if (side === "long" && bullish) return "aligned";
  if (side === "short" && bearish) return "aligned";
  return "opposed";
}

function openingRangeAlignment(
  side: Side,
  event: OpeningRangeEvent,
): TradeIdea["openingRangeAlignment"] {
  if (event === "inside") return "inside";
  if (side === "long" && event === "break-up") return "aligned";
  if (side === "short" && event === "break-down") return "aligned";
  return "opposed";
}

function recencyPhrase(sessions: number): string {
  if (sessions <= 0) return "reported this session";
  if (sessions === 1) return "reported last session";
  return `reported ${sessions} sessions ago`;
}

function sentimentWord(sentiment: Sentiment): string {
  if (sentiment === "positive") return "positive";
  if (sentiment === "negative") return "negative";
  if (sentiment === "mixed") return "mixed";
  return "neutral";
}

function vwapPhrase(event: VwapEvent): string {
  switch (event) {
    case "reclaim":
      return "reclaimed VWAP";
    case "reject":
      return "rejected at VWAP";
    case "holding-above":
      return "holding above VWAP";
    case "holding-below":
      return "holding below VWAP";
    case "chop":
      return "chopping around VWAP";
  }
}

function openingRangePhrase(event: OpeningRangeEvent): string {
  switch (event) {
    case "break-up":
      return "the opening range is broken higher";
    case "break-down":
      return "the opening range is broken lower";
    case "inside":
      return "price is still inside the opening range";
  }
}

function confidenceFor(input: {
  status: Snapshot["pattern"]["status"];
  news: TradeIdea["newsAlignment"];
  earnings: TradeIdea["earningsAlignment"];
  age: TradeIdea["earningsAge"];
  relativeVolume: number;
  vwap: TradeIdea["vwapAlignment"];
  openingRange: TradeIdea["openingRangeAlignment"];
  clearsMinimumReward: boolean;
}): number {
  let score = 36;
  if (input.status === "triggered") score += 18;
  else if (input.status === "forming") score += 6;

  if (input.news === "aligned") score += 16;
  else if (input.news === "neutral") score += 4;
  else if (input.news === "opposed") score -= 16;

  if (input.earnings === "aligned" && input.age === "fresh") score += 14;
  else if (input.earnings === "aligned" && input.age === "recent") score += 8;
  else if (input.earnings === "flat") score += 2;
  else if (input.earnings === "opposed" && input.age === "fresh") score -= 14;
  else if (input.earnings === "opposed") score -= 4;
  if (input.age === "stale") score -= 4;

  if (input.relativeVolume >= 2) score += 12;
  else if (input.relativeVolume >= 1.3) score += 8;
  else if (input.relativeVolume >= 1) score += 3;
  else score -= 6;

  if (input.vwap === "aligned") score += 12;
  else if (input.vwap === "chop") score -= 4;
  else score -= 12;

  if (input.openingRange === "aligned") score += 8;
  else if (input.openingRange === "opposed") score -= 8;

  if (input.clearsMinimumReward) score += 6;
  else score -= 8;

  // 122 is every bonus at once (triggered, aligned news, fresh earnings beat,
  // 2× volume, VWAP, opening range, and a target that clears the minimum).
  const normalized = Math.round((score / 122) * 96);
  return Math.max(8, Math.min(96, normalized));
}

function levelsFor(snapshot: Snapshot, side: Side) {
  const band = snapshot.atr * ENTRY_BAND;
  if (side === "long") {
    const entryHigh = roundPrice(snapshot.last);
    const entryLow = roundPrice(snapshot.last - band);
    const stop = roundPrice(entryHigh - snapshot.atr);
    const riskPerShare = roundPrice(entryHigh - stop);
    const target = roundPrice(snapshot.measuredTarget);
    const reward = roundPrice(target - entryHigh);
    const riskReward = riskPerShare > 0 ? reward / riskPerShare : 0;
    return { entryLow, entryHigh, stop, target, riskPerShare, riskReward };
  }

  const entryLow = roundPrice(snapshot.last);
  const entryHigh = roundPrice(snapshot.last + band);
  const stop = roundPrice(entryLow + snapshot.atr);
  const riskPerShare = roundPrice(stop - entryLow);
  const target = roundPrice(snapshot.measuredTarget);
  const reward = roundPrice(entryLow - target);
  const riskReward = riskPerShare > 0 ? reward / riskPerShare : 0;
  return { entryLow, entryHigh, stop, target, riskPerShare, riskReward };
}

function formatRatio(value: number): string {
  const two = value.toFixed(2);
  if (Number(two) > value) return `${value.toFixed(3)}:1`;
  return `${two}:1`;
}

function formatSurprise(surprise: number): string {
  const abs = Math.abs(surprise).toFixed(2);
  if (surprise > 0) return `beat by ${abs}%`;
  if (surprise < 0) return `missed by ${abs}%`;
  return "matched the estimate";
}

export function evaluateSnapshot(
  snapshot: Snapshot,
  settings: RiskSettings,
): Omit<TradeIdea, "rank"> {
  const side: Side = snapshot.pattern.bias === "bullish" ? "long" : "short";
  const surpriseInfo = earningsSurpriseOf(snapshot.earnings);
  const surprise = surpriseInfo.pct;
  const age = earningsAge(snapshot.earnings.recencySessions);
  const news = newsAlignment(side, snapshot.news.sentiment);
  const earnings = earningsAlignment(side, surprise);
  const vwap = vwapAlignment(side, snapshot.vwapEvent);
  const openingRange = openingRangeAlignment(side, snapshot.openingRangeEvent);
  const levels = levelsFor(snapshot, side);
  const clearsMinimumReward = levels.riskReward + 1e-9 >= settings.minRewardRisk;

  const riskBudget = roundPrice(settings.accountSize * (settings.maxRiskPct / 100));
  const indicatedShares =
    levels.riskPerShare > 0 ? Math.floor(riskBudget / levels.riskPerShare) : 0;

  const conflicts: string[] = [];

  if (snapshot.pattern.status === "failed") {
    conflicts.push("The chart pattern has failed.");
  } else if (snapshot.pattern.status === "forming") {
    conflicts.push("The chart pattern has not triggered.");
  }

  if (news === "opposed") {
    conflicts.push(
      `News fights the ${side}: the headline sentiment is ${sentimentWord(snapshot.news.sentiment)}.`,
    );
  }

  if (vwap === "opposed") {
    conflicts.push(`Price ${vwapPhrase(snapshot.vwapEvent)}, which fights the ${side}.`);
  }

  if (openingRange === "opposed") {
    conflicts.push("The opening range broke the other way.");
  }

  if (earnings === "opposed" && age === "fresh") {
    conflicts.push(
      `The ${surpriseInfo.basis === "eps" ? "EPS" : "revenue"} print is fresh (${recencyPhrase(snapshot.earnings.recencySessions)}) and ${formatSurprise(surprise)}, which fights a ${side}.`,
    );
  }

  if (!clearsMinimumReward) {
    conflicts.push(
      `Reward to risk is ${formatRatio(levels.riskReward)}, short of the ${formatRatio(settings.minRewardRisk)} minimum.`,
    );
  }

  if (levels.riskPerShare <= 0) {
    conflicts.push("The ATR stop is not beyond the entry.");
  } else if (indicatedShares < 1) {
    conflicts.push(
      "At this account size and risk cap, the ATR stop does not leave enough budget for one share.",
    );
  }

  const stance = conflicts.length > 0 ? "stand-aside" : "consider";
  const suggestedShares = stance === "consider" ? indicatedShares : 0;
  const riskDollars = roundPrice(suggestedShares * levels.riskPerShare);
  const notional = roundPrice((stance === "consider" ? suggestedShares : 0) * snapshot.last);

  const reasons = buildReasons({
    snapshot,
    levels,
    settings,
    conflicts,
    stance,
  });

  return {
    symbol: snapshot.symbol,
    name: snapshot.name,
    side,
    stance,
    entryLow: levels.entryLow,
    entryHigh: levels.entryHigh,
    stop: levels.stop,
    target: levels.target,
    riskReward: levels.riskReward,
    clearsMinimumReward,
    confidence: confidenceFor({
      status: snapshot.pattern.status,
      news,
      earnings,
      age,
      relativeVolume: snapshot.relativeVolume,
      vwap,
      openingRange,
      clearsMinimumReward,
    }),
    reasons,
    conflicts,
    suggestedShares,
    indicatedShares,
    riskPerShare: levels.riskPerShare,
    riskDollars,
    riskBudget,
    notional,
    accountSize: settings.accountSize,
    maxRiskPct: settings.maxRiskPct,
    minRewardRisk: settings.minRewardRisk,
    news: snapshot.news,
    earnings: snapshot.earnings,
    earningsSurprisePct: surprise,
    earningsSurpriseBasis: surpriseInfo.basis,
    atrTimeframe: snapshot.atrTimeframe,
    pattern: snapshot.pattern,
    relativeVolume: snapshot.relativeVolume,
    vwap: snapshot.vwap,
    vwapEvent: snapshot.vwapEvent,
    openingRangeHigh: snapshot.openingRangeHigh,
    openingRangeLow: snapshot.openingRangeLow,
    openingRangeEvent: snapshot.openingRangeEvent,
    atr: snapshot.atr,
    last: snapshot.last,
    newsAlignment: news,
    earningsAlignment: earnings,
    earningsAge: age,
    vwapAlignment: vwap,
    openingRangeAlignment: openingRange,
  };
}

function buildReasons(input: {
  snapshot: Snapshot;
  levels: ReturnType<typeof levelsFor>;
  settings: RiskSettings;
  conflicts: string[];
  stance: TradeIdea["stance"];
}): string[] {
  const { snapshot, levels, settings, conflicts } = input;
  const earnings: EarningsPillar = snapshot.earnings;
  const reasons: string[] = [];

  if (conflicts.length > 0) {
    reasons.push(`Stand aside. ${conflicts.join(" ")}`);
  }

  reasons.push(
    `${snapshot.pattern.name} (${snapshot.pattern.status}). ${snapshot.pattern.note}`,
  );

  reasons.push(
    `News catalyst: ${snapshot.news.catalyst}. “${snapshot.news.headline}” The tone is ${sentimentWord(snapshot.news.sentiment)}.`,
  );

  const surpriseInfo = earningsSurpriseOf(snapshot.earnings);
  const hasConsensus =
    (surpriseInfo.basis === "eps" &&
      typeof earnings.epsActual === "number" &&
      typeof earnings.epsEstimate === "number") ||
    (surpriseInfo.basis === "revenue" && typeof earnings.revenueEstimate === "number");
  if (!hasConsensus) {
    reasons.push(`${earnings.period} did not include a revenue or EPS consensus.`);
  } else {
    const surpriseText =
      surpriseInfo.pct >= 0
        ? `${surpriseInfo.pct.toFixed(2)}% above the estimate`
        : `${Math.abs(surpriseInfo.pct).toFixed(2)}% under the estimate`;
    const printName = surpriseInfo.basis === "eps" ? "EPS" : "revenue";
    reasons.push(
      `${earnings.period} ${printName} was ${surpriseText}, ${recencyPhrase(earnings.recencySessions)}.`,
    );
  }

  reasons.push(
    `Relative volume is ${snapshot.relativeVolume.toFixed(1)}×. Price ${vwapPhrase(snapshot.vwapEvent)} (${openingRangePhrase(snapshot.openingRangeEvent)}).`,
  );

  reasons.push(
    `The stop is one ${snapshot.atrTimeframe ?? "intraday"} ATR (${snapshot.atr.toFixed(2)}) from the near edge of the entry zone, at ${levels.stop.toFixed(2)}. The measured move to ${levels.target.toFixed(2)} pays ${formatRatio(levels.riskReward)} against your ${formatRatio(settings.minRewardRisk)} minimum.`,
  );

  if (input.stance === "consider") {
    reasons.push(
      `Size is the floor of a ${settings.maxRiskPct.toFixed(2)}% account risk divided by that ATR stop.`,
    );
  }

  return reasons;
}

export function rankIdeas(snapshots: Snapshot[], settings: RiskSettings): TradeIdea[] {
  const ideas = snapshots.map((snapshot) => evaluateSnapshot(snapshot, settings));
  ideas.sort((a, b) => {
    if (a.stance !== b.stance) return a.stance === "consider" ? -1 : 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.riskReward - a.riskReward;
  });
  return ideas.map((idea, index) => ({ ...idea, rank: index + 1 }));
}
