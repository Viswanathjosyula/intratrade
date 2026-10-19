import { averageTrueRange, type Bar } from "./patterns";
import { addTradingSessions, estimatedReach, newYorkSessionDate } from "./reach";
import type { Side } from "./types";

/** A consider call that was published on a session. Outcomes are not stored here. */
export interface PublishedCall {
  symbol: string;
  side: Side;
  target: number;
  stop: number;
  /** New York session date the call was published, YYYY-MM-DD. */
  asOf: string;
}

export type CallStatus = "reached" | "not-reached" | "open";

export interface TrackedCall extends PublishedCall {
  status: CallStatus;
}

export interface SessionPrint {
  date: string;
  high: number;
  low: number;
  close: number;
}

export interface IntradayPrint {
  date: string;
  time: number;
  high: number;
  low: number;
}

export interface ScoreOutcome {
  status: CallStatus;
  /**
   * A later session traded both the target and the stop. Daily bars cannot
   * say which came first, and no intraday bars were supplied.
   */
  needsIntradayOn?: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function callKey(call: Pick<PublishedCall, "symbol" | "side" | "target">): string {
  return `${call.symbol}|${call.side}|${call.target.toFixed(2)}`;
}

/** Keep the first published call for each symbol, side, and target. */
export function mergeCalls(existing: PublishedCall[], incoming: PublishedCall[]): PublishedCall[] {
  const seen = new Set(existing.map(callKey));
  const next = [...existing];
  for (const call of incoming) {
    const key = callKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(call);
  }
  return next;
}

/**
 * The as-of session has a Yahoo bar, and that close sits between the stop and
 * the target. Otherwise the published levels cannot be tied to the session.
 */
export function levelsConfirmed(call: PublishedCall, daily: SessionPrint[]): boolean {
  if (!DATE.test(call.asOf)) return false;
  if (!Number.isFinite(call.target) || !Number.isFinite(call.stop)) return false;
  const bar = daily.find((print) => print.date === call.asOf);
  if (!bar || !Number.isFinite(bar.close)) return false;
  if (call.side === "long") return call.target > bar.close && bar.close > call.stop;
  return call.stop > bar.close && bar.close > call.target;
}

export function paceDateFor(call: PublishedCall, daily: SessionPrint[]): string | null {
  const index = daily.findIndex((print) => print.date === call.asOf);
  if (index < 1) return null;
  const slice = daily.slice(0, index + 1);
  const bars: Bar[] = slice.map((print) => ({
    time: 0,
    open: print.close,
    high: print.high,
    low: print.low,
    close: print.close,
    volume: 0,
  }));
  const atr = averageTrueRange(bars, 14);
  const estimate = estimatedReach({
    asOf: `${call.asOf}T15:00:00.000Z`,
    last: slice[index].close,
    target: call.target,
    atr,
    atrTimeframe: "daily",
  });
  return estimate?.date ?? null;
}

/**
 * Reached: a later regular session trades the target before the stop.
 * Not reached: the stop trades first, or the pace date has passed with no
 * target touch and no missing session in between.
 * Open: neither is confirmed. A day that trades both levels stays open unless
 * intraday bars show which print came first.
 */
export function scoreCall(input: {
  call: PublishedCall;
  daily: SessionPrint[];
  intraday?: IntradayPrint[];
  now: Date;
}): ScoreOutcome {
  const call = input.call;
  const daily = [...input.daily].sort((a, b) => a.date.localeCompare(b.date));
  const asOfBar = daily.find((print) => print.date === call.asOf);
  if (!asOfBar) return { status: "open" };

  const paceDate = paceDateFor(call, daily);
  const lastDate = daily[daily.length - 1]?.date ?? call.asOf;
  const expected = weekdaysAfter(call.asOf, lastDate);
  const byDate = new Map(daily.map((print) => [print.date, print]));
  let gap = false;

  for (const date of expected) {
    const bar = byDate.get(date);
    if (!bar) {
      gap = true;
      continue;
    }
    const targetHit = tradedTarget(call, bar);
    const stopHit = tradedStop(call, bar);
    if (!targetHit && !stopHit) continue;
    if (gap) return { status: "open" };
    if (targetHit && stopHit) {
      if (!input.intraday) return { status: "open", needsIntradayOn: date };
      const decision = firstIntradayTouch(
        call,
        input.intraday.filter((print) => print.date === date),
      );
      return { status: decision ?? "open" };
    }
    if (targetHit) return { status: "reached" };
    return { status: "not-reached" };
  }

  if (paceDate && paceHasPassed(paceDate, input.now) && !gapThrough(call.asOf, paceDate, byDate)) {
    return { status: "not-reached" };
  }
  return { status: "open" };
}

export function newYorkMinutes(now: Date): { date: string; minutes: number } | null {
  const date = newYorkSessionDate(now.toISOString());
  if (!date) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  if (!parts.hour || !parts.minute) return null;
  return { date, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function paceHasPassed(paceDate: string, now: Date): boolean {
  const clock = newYorkMinutes(now);
  if (!clock) return false;
  if (clock.date > paceDate) return true;
  if (clock.date < paceDate) return false;
  return clock.minutes >= 16 * 60;
}

function gapThrough(asOf: string, paceDate: string, byDate: Map<string, SessionPrint>): boolean {
  if (!byDate.has(paceDate)) return true;
  return weekdaysAfter(asOf, paceDate).some((date) => !byDate.has(date));
}

function weekdaysAfter(startExclusive: string, endInclusive: string): string[] {
  if (!DATE.test(startExclusive) || !DATE.test(endInclusive) || endInclusive <= startExclusive) {
    return [];
  }
  const dates: string[] = [];
  let cursor = startExclusive;
  while (cursor < endInclusive) {
    const next = addTradingSessions(cursor, 1);
    if (!next || next > endInclusive) break;
    dates.push(next);
    cursor = next;
  }
  return dates;
}

function tradedTarget(call: PublishedCall, bar: { high: number; low: number }): boolean {
  if (call.side === "long") return bar.high + 1e-8 >= call.target;
  return bar.low - 1e-8 <= call.target;
}

function tradedStop(call: PublishedCall, bar: { high: number; low: number }): boolean {
  if (call.side === "long") return bar.low - 1e-8 <= call.stop;
  return bar.high + 1e-8 >= call.stop;
}

function firstIntradayTouch(call: PublishedCall, bars: IntradayPrint[]): CallStatus | null {
  const ordered = [...bars].sort((a, b) => a.time - b.time);
  for (const bar of ordered) {
    const targetHit = tradedTarget(call, bar);
    const stopHit = tradedStop(call, bar);
    if (targetHit && stopHit) return null;
    if (targetHit) return "reached";
    if (stopHit) return "not-reached";
  }
  return null;
}
