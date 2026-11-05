import { price } from "@/lib/format";
import type { MarketMood, MarketMoodName, MoodLevel, Side } from "./types";

export const SHORT_AVERAGE_SESSIONS = 10;

export function shortAverage(closes: readonly number[], window = SHORT_AVERAGE_SESSIONS): number | null {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  if (slice.some((close) => !Number.isFinite(close) || close <= 0)) return null;
  return slice.reduce((sum, close) => sum + close, 0) / window;
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Last versus the short average. Supportive means the last print is above that average. */
export function levelFromCloses(last: number, closes: readonly number[]): MoodLevel | null {
  const average = shortAverage(closes);
  if (average == null || !Number.isFinite(last) || last <= 0) return null;
  const roundedLast = roundCents(last);
  const roundedAverage = roundCents(average);
  return {
    last: roundedLast,
    average: roundedAverage,
    supportive: roundedLast > roundedAverage,
  };
}

/** VIX is supportive when it is below its short average. */
export function vixLevel(last: number, closes: readonly number[]): MoodLevel | null {
  const level = levelFromCloses(last, closes);
  if (!level) return null;
  return { ...level, supportive: level.last < level.average };
}

export function breadthSupportive(aboveCount: number, counted: number): boolean | null {
  if (counted <= 0 || aboveCount < 0 || aboveCount > counted) return null;
  const below = counted - aboveCount;
  if (aboveCount > below) return true;
  if (below > aboveCount) return false;
  return null;
}

type Vote = "on" | "off" | "split";

export function buildMarketMood(input: {
  spy: MoodLevel | null;
  vix: MoodLevel | null;
  aboveCount: number;
  counted: number;
}): MarketMood | null {
  const breadth = breadthSupportive(input.aboveCount, input.counted);
  const votes: Vote[] = [];
  if (input.spy) votes.push(input.spy.supportive ? "on" : "off");
  if (input.vix) votes.push(input.vix.supportive ? "on" : "off");
  if (input.counted > 0) votes.push(breadth === true ? "on" : breadth === false ? "off" : "split");
  if (votes.length === 0) return null;

  const ons = votes.filter((vote) => vote === "on").length;
  const offs = votes.filter((vote) => vote === "off").length;
  let name: MarketMoodName = "mixed";
  if (ons === votes.length && votes.length >= 2) name = "risk-on";
  else if (offs === votes.length && votes.length >= 2) name = "risk-off";

  return {
    name,
    window: SHORT_AVERAGE_SESSIONS,
    spy: input.spy,
    vix: input.vix,
    aboveCount: input.aboveCount,
    counted: input.counted,
    breadthSupportive: breadth,
    summary: moodSummary(input),
  };
}

function relation(last: number, average: number): "above" | "below" | "equal to" {
  if (last > average) return "above";
  if (last < average) return "below";
  return "equal to";
}

function moodSummary(input: {
  spy: MoodLevel | null;
  vix: MoodLevel | null;
  aboveCount: number;
  counted: number;
}): string {
  const spy = input.spy
    ? `SPY ${price(input.spy.last)} is ${relation(input.spy.last, input.spy.average)} its ${SHORT_AVERAGE_SESSIONS}-session average of ${price(input.spy.average)}.`
    : "SPY did not come back from Yahoo.";
  const breadth =
    input.counted > 0
      ? `${input.aboveCount} of ${input.counted} names are above their ${SHORT_AVERAGE_SESSIONS}-session average.`
      : "No name on the book had 10 sessions for an average.";
  const vix = input.vix
    ? `VIX ${price(input.vix.last)} is ${relation(input.vix.last, input.vix.average)} its ${SHORT_AVERAGE_SESSIONS}-session average of ${price(input.vix.average)}.`
    : "VIX did not come back from Yahoo.";
  return `${spy} ${breadth} ${vix}`;
}

export function moodLabel(name: MarketMoodName): string {
  if (name === "risk-on") return "Risk-on";
  if (name === "risk-off") return "Risk-off";
  return "Mixed";
}

/** Take the consider only when the mood and the side agree. Otherwise wait. */
export function timingCall(
  mood: MarketMoodName,
  side: Side,
): { action: "take" | "wait"; line: string } {
  if (mood === "risk-on" && side === "long") {
    return { action: "take", line: "Take it. The tape is risk-on, and this name is a long." };
  }
  if (mood === "risk-off" && side === "short") {
    return { action: "take", line: "Take it. The tape is risk-off, and this name is a short." };
  }
  if (mood === "risk-on" && side === "short") {
    return { action: "wait", line: "Wait. The tape is risk-on, so this short is fighting the mood." };
  }
  if (mood === "risk-off" && side === "long") {
    return { action: "wait", line: "Wait. The tape is risk-off, so this long is fighting the mood." };
  }
  if (side === "long") {
    return {
      action: "wait",
      line: "Wait. The tape is mixed, so this long does not have the market with it.",
    };
  }
  return {
    action: "wait",
    line: "Wait. The tape is mixed, so this short does not have the market with it.",
  };
}
