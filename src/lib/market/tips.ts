import { price, sideLabel } from "@/lib/format";
import { confidenceParts, type StatusReason, type TrackedCall } from "@/lib/market/calls";
import { moodLabel, timingCall } from "@/lib/market/mood";
import { formatSessionDate } from "@/lib/market/reach";
import type { IndicatorRow, IndicatorTape, MarketMood, MarketMoodName, Side } from "@/lib/market/types";

export const HEADER_TIPS = {
  name: "Name is the ticker this row tracks.",
  side: "Side is long when the target is above the added price, and short when the target is below it.",
  added: "Added at is the price stored when the call was published.",
  target: "Target is the stored price this call is tracking.",
  confidence:
    "Confidence is 100% when the target has been reached. Otherwise it averages the readings on the row: target before the stop, distance left versus daily ATR, whether the pace date is still ahead, and whether the side agrees with the mood. A row is listed only when that percent is above 50%.",
  asOf: "As of is the New York session when the call was added.",
  pace: "Pace is the first date the target was expected, walking one daily ATR per session from the added price.",
  newPace: "New pace is set only after the original pace date passes without the target printing.",
  status: "Status is Reached when a later session trades the target before the stop, Not reached when the stop prints first or the pace date passes, and Open when neither is confirmed.",
} as const;

export interface RowTips {
  name: string;
  side: string;
  added: string;
  target: string;
  confidence: string;
  asOf: string;
  pace: string;
  newPace: string;
  status: string;
}

export function rowTips(call: TrackedCall, through: string | null, mood: MarketMoodName | null): RowTips {
  const symbol = call.symbol;
  const side = sideWord(call.side);
  const added = addedText(call.entry);
  const target = price(call.target);
  const asOf = formatSessionDate(call.asOf);
  return {
    name: `Name is the ticker on this row. ${symbol} is a ${side}, added at ${added} on ${asOf}, with target ${target}.`,
    side: sideTip(call),
    added: `Added at is the price stored when the call was published. ${symbol} was added at ${added} on ${asOf}.`,
    target: targetTip(call),
    confidence: confidenceTip(call, through, mood),
    asOf: `As of is the New York session when the call was added. ${symbol} was added ${asOf}.`,
    pace: paceTip(call),
    newPace: newPaceTip(call),
    status: statusTip(call, through),
  };
}

export function statusGroupTip(status: "reached" | "not-reached" | "open"): string {
  if (status === "reached") return "Reached means a later session traded the target before the stop.";
  if (status === "not-reached") {
    return "Not reached means the stop printed before the target, or the pace date passed with no target print.";
  }
  return "Open means neither the target nor the stop is confirmed, and the pace date has not passed.";
}

export function moodTip(mood: MarketMood): string {
  const rule =
    mood.name === "risk-on"
      ? "Risk-on means every vote that came back is on, and at least two votes are in."
      : mood.name === "risk-off"
        ? "Risk-off means every vote that came back is off, and at least two votes are in."
        : "Mixed means the votes are not all on and not all off.";
  return `${rule} ${mood.summary}`;
}

export function timingTip(mood: MarketMood, side: Side, symbol: string): string {
  const call = timingCall(mood.name, side);
  const word = call.action === "take" ? "Take" : "Wait";
  const meaning =
    call.action === "take"
      ? "Take means the side agrees with the mood."
      : "Wait means the side fights the mood, or the mood is mixed.";
  return `${meaning} ${symbol} is a ${sideWord(side)} and the tape is ${moodLabel(mood.name).toLowerCase()}, so this line says ${word.toLowerCase()}. ${mood.summary}`;
}

const TREND_RULE: Record<string, string> = {
  "S&P 500": "A rising S&P points up with an up tape.",
  "S&P after elections": "A post-election return above its usual change points up with an up tape.",
  "10-year yield": "A falling yield points up, because lower yields line up with an up tape.",
  CPI: "Cooler inflation than the prior year points up with an up tape.",
  "TIPS vs Treasuries": "TIPS lagging Treasuries points up with an up tape.",
  Dollar: "A falling dollar points up with an up tape.",
  Oil: "Falling oil points up with an up tape.",
};

export function trendTip(row: IndicatorRow, tape: IndicatorTape | null): string {
  const word = row.alignment === "with" ? "With" : "Against";
  const meaning =
    row.alignment === "with"
      ? "With means this factor points the same way as the S&P tape."
      : "Against means this factor points the opposite way from the S&P tape.";
  const tapeBit = tape
    ? `The tape points ${tape.side}: S&P ${price(tape.last)} is ${tape.relation} its 10-session average of ${price(tape.average)}.`
    : "The S&P tape did not come back.";
  const rule = TREND_RULE[row.factor] ?? "The factor's own rule sets which way the statistic points.";
  const pointed = row.points === "flat" ? "flat" : row.points;
  return `${meaning} ${tapeBit} ${rule} This row is ${row.statistic}, which points ${pointed}, so the label is ${word}.`;
}

function sideWord(side: Side): string {
  return side === "long" ? "long" : "short";
}

function addedText(entry: number | undefined): string {
  if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) return "an unstored price";
  return price(entry);
}

function sideTip(call: TrackedCall): string {
  const word = sideLabel(call.side);
  const meaning =
    call.side === "long"
      ? "Long means the target is above the added price."
      : "Short means the target is below the added price.";
  if (typeof call.entry !== "number" || !(call.entry > 0)) {
    return `${meaning} ${call.symbol}'s added price was not stored. The target is ${price(call.target)}.`;
  }
  return `${meaning} ${call.symbol} was added at ${price(call.entry)} and the target is ${price(call.target)}.`;
}

function targetTip(call: TrackedCall): string {
  const target = price(call.target);
  if (typeof call.entry !== "number" || !(call.entry > 0)) {
    return `Target is the stored price this row tracks. This ${sideWord(call.side)} target is ${target}. The added price was not stored.`;
  }
  const place = call.target > call.entry ? "above" : call.target < call.entry ? "below" : "at";
  return `Target is the stored price this row tracks. This ${sideWord(call.side)} target is ${target}, ${place} the added price ${price(call.entry)}.`;
}

function confidenceTip(call: TrackedCall, through: string | null, mood: MarketMoodName | null): string {
  const parts = confidenceParts({ ...call, through, mood });
  if (call.status === "reached") {
    return `Confidence is 100% when the target has been reached. This ${call.symbol} target ${price(call.target)} has been reached, so the confidence is 100%.`;
  }
  if (parts.percent == null) {
    return `Confidence averages the readings on this row. ${call.symbol} has none of those readings, so no percent is shown.`;
  }
  const readings = [
    barrierSentence(call, parts.barrier, parts.risk, parts.reward),
    closenessSentence(call, parts.closeness, parts.distance),
    paceSentence(call, parts.pace, through),
    moodSentence(call, parts.mood, mood),
  ].filter((line): line is string => line != null);
  return `Confidence averages the readings on this row and rounds. This ${call.symbol} ${sideWord(call.side)} is ${parts.percent}%. ${readings.join(" ")} It is listed because ${parts.percent}% is above 50%.`;
}

function barrierSentence(
  call: TrackedCall,
  reading: number | null,
  risk: number | null,
  reward: number | null,
): string | null {
  if (reading == null || risk == null || reward == null || typeof call.entry !== "number") return null;
  return `Target before the stop is ${pct(reading)} from added ${price(call.entry)}, target ${price(call.target)}, and stop ${price(call.stop)} (risk ${price(risk)}, reward ${price(reward)}).`;
}

function closenessSentence(call: TrackedCall, reading: number | null, distance: number | null): string | null {
  if (reading == null || distance == null || call.latestClose == null || call.dailyAtr == null) return null;
  return `Distance left is ${pct(reading)}: ${price(distance)} left from the close ${price(call.latestClose)} to the target ${price(call.target)}, against daily ATR ${price(call.dailyAtr)}.`;
}

function paceSentence(call: TrackedCall, reading: number | null, through: string | null): string | null {
  if (reading == null) return null;
  if (call.nextPaceDate) {
    return `Pace is ${pct(reading)} because the original pace ${formatSessionDate(call.paceDate ?? "")} passed and a new pace is set.`;
  }
  if (call.paceDate && through) {
    const ahead = call.paceDate > through;
    return `Pace is ${pct(reading)} because ${formatSessionDate(call.paceDate)} is ${ahead ? "still ahead of" : "not ahead of"} ${formatSessionDate(through)}.`;
  }
  return null;
}

function moodSentence(call: TrackedCall, reading: number | null, mood: MarketMoodName | null): string | null {
  if (reading == null || !mood) return null;
  if (mood === "mixed") return `Mood is ${pct(reading)} because the tape is mixed.`;
  const agrees = (mood === "risk-on" && call.side === "long") || (mood === "risk-off" && call.side === "short");
  return `Mood is ${pct(reading)} because this ${sideWord(call.side)} ${agrees ? "agrees with" : "fights"} ${moodLabel(mood).toLowerCase()}.`;
}

function pct(reading: number): string {
  return `${Math.round(reading * 100)}%`;
}

function paceTip(call: TrackedCall): string {
  if (!call.paceDate) {
    return `Pace is the first date the target was expected, walking one daily ATR per session from the added price. ${call.symbol} has no pace date because that walk could not be made from ${formatSessionDate(call.asOf)}.`;
  }
  return `Pace is the first date the target was expected, walking one daily ATR per session from the added price. This ${call.symbol} pace is ${formatSessionDate(call.paceDate)}.`;
}

function newPaceTip(call: TrackedCall): string {
  if (call.nextPaceDate) {
    const from =
      call.latestClose != null && call.dailyAtr != null
        ? ` It is walked from the latest close ${price(call.latestClose)} at daily ATR ${price(call.dailyAtr)}.`
        : "";
    return `New pace is set only after the original pace date passes without the target printing. This ${call.symbol} new pace is ${formatSessionDate(call.nextPaceDate)}.${from}`;
  }
  if (call.status === "reached") {
    return `New pace stays blank once the target has been reached. This ${call.symbol} target ${price(call.target)} is reached, so no new pace is set.`;
  }
  if (call.paceDate) {
    return `New pace stays blank until the pace date passes without the target printing. This ${call.symbol} pace is ${formatSessionDate(call.paceDate)} and no new date is set.`;
  }
  return `New pace stays blank when there is no original pace date. ${call.symbol} has neither.`;
}

function statusTip(call: TrackedCall, through: string | null): string {
  const symbol = call.symbol;
  const target = price(call.target);
  const stop = price(call.stop);
  const reason = reasonFor(call);
  if (reason === "target-before-stop") {
    return `Reached means a later session traded the target before the stop. This ${symbol} target ${target} printed before the stop ${stop}.`;
  }
  if (reason === "stop-before-target") {
    return `Not reached means the stop printed before the target, or the pace date passed with no target print. This ${symbol} stop ${stop} printed before the target ${target}.`;
  }
  if (reason === "pace-missed") {
    const pace = call.paceDate ? formatSessionDate(call.paceDate) : "the pace date";
    const next = call.nextPaceDate ? ` The new pace is ${formatSessionDate(call.nextPaceDate)}.` : "";
    return `Not reached means the stop printed before the target, or the pace date passed with no target print. This ${symbol} pace ${pace} passed without the target ${target} printing.${next}`;
  }
  if (reason === "unconfirmed") {
    const checked = through ? ` Bars are checked through ${formatSessionDate(through)}.` : "";
    return `Open means the book cannot yet confirm which level printed. This ${symbol} target is ${target} and the stop is ${stop}.${checked}`;
  }
  const pace = call.paceDate ? ` Pace is ${formatSessionDate(call.paceDate)}.` : " No pace date is stored.";
  const checked = through ? ` Checked through ${formatSessionDate(through)}.` : "";
  return `Open means neither the target nor the stop is confirmed, and the pace date has not passed. This ${symbol} target is ${target} and the stop is ${stop}.${pace}${checked}`;
}

function reasonFor(call: TrackedCall): StatusReason {
  if (call.reason) return call.reason;
  if (call.status === "reached") return "target-before-stop";
  if (call.status === "not-reached" && call.nextPaceDate) return "pace-missed";
  if (call.status === "not-reached") return "stop-before-target";
  return "awaiting";
}
