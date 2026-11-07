import { averageTrueRange, type Bar } from "./patterns";
import { addTradingSessions, estimatedReach, newYorkSessionDate } from "./reach";
import type { MarketMoodName, Side } from "./types";

/** A consider call that was published on a session. Outcomes are not stored here. */
export interface PublishedCall {
  symbol: string;
  side: Side;
  target: number;
  stop: number;
  /**
   * Last price stored when the call was published. Absent on rows written
   * before that price was kept. Never backfilled.
   */
  entry?: number;
  /** New York session date the call was published, YYYY-MM-DD. */
  asOf: string;
}

export type CallStatus = "reached" | "not-reached" | "open";

export interface SuggestionRates {
  reached: number;
  notReached: number;
  open: number;
  /** Reached divided by settled rows. Null when every row is still open. */
  settled: number | null;
  /** Reached divided by every row. Null when the log is empty. */
  share: number | null;
}

/** Hit rates from the rows on the table. Open calls stay out of the settled denominator. */
export function suggestionRates(calls: ReadonlyArray<{ status: CallStatus }>): SuggestionRates {
  const reached = calls.filter((call) => call.status === "reached").length;
  const notReached = calls.filter((call) => call.status === "not-reached").length;
  const open = calls.filter((call) => call.status === "open").length;
  const settledTotal = reached + notReached;
  const all = settledTotal + open;
  return {
    reached,
    notReached,
    open,
    settled: settledTotal === 0 ? null : reached / settledTotal,
    share: all === 0 ? null : reached / all,
  };
}

/**
 * One unresolved row per symbol: the latest open or not-reached call.
 * Reached calls stay, so a name can be picked again after a target prints.
 * Prices on the kept row are the stored added price and target.
 */
export function ledgerRows<T extends { symbol: string; status: CallStatus; asOf: string }>(
  calls: readonly T[],
): T[] {
  const latestUnresolved = new Map<string, { index: number; call: T }>();
  calls.forEach((call, index) => {
    if (call.status === "reached") return;
    const previous = latestUnresolved.get(call.symbol);
    const later =
      !previous ||
      call.asOf > previous.call.asOf ||
      (call.asOf === previous.call.asOf && index > previous.index);
    if (later) latestUnresolved.set(call.symbol, { index, call });
  });
  const active = new Set([...latestUnresolved.values()].map((item) => item.call));
  return calls.filter((call) => call.status === "reached" || active.has(call));
}

/** Table order: reached, then not reached, then open. Inside a block, newest as-of day first. */
export function groupCalls<T extends { status: CallStatus; asOf?: string }>(
  calls: readonly T[],
): Array<{ status: CallStatus; calls: T[] }> {
  const order: CallStatus[] = ["reached", "not-reached", "open"];
  return order.map((status) => ({
    status,
    calls: calls
      .filter((call) => call.status === status)
      .sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? "")),
  }));
}

/**
 * Chance the stored target gets tagged.
 * Reached calls are 100%. Every other call averages the readings that exist:
 * target before the stop, closeness in daily ATRs, pace still ahead, side with the mood.
 * A missing reading is left out. It is not filled in.
 */
export function callConfidence(input: {
  status: CallStatus;
  side: Side;
  target: number;
  stop: number;
  entry?: number;
  paceDate: string | null;
  nextPaceDate: string | null;
  latestClose: number | null;
  dailyAtr: number | null;
  through: string | null;
  mood: MarketMoodName | null;
}): number | null {
  if (input.status === "reached") return 100;
  const parts = [targetBeforeStop(input), atrCloseness(input), paceReading(input), moodReading(input)].filter(
    (part): part is number => part != null,
  );
  if (parts.length === 0) return null;
  const mean = parts.reduce((sum, part) => sum + part, 0) / parts.length;
  return Math.round(mean * 100);
}

export function confidenceLabel(percent: number | null): string {
  return percent == null ? "—" : `${percent}%`;
}

function targetBeforeStop(input: {
  side: Side;
  target: number;
  stop: number;
  entry?: number;
}): number | null {
  const entry = input.entry;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(input.target) || !Number.isFinite(input.stop)) return null;
  const reward = input.side === "long" ? input.target - entry : entry - input.target;
  const risk = input.side === "long" ? entry - input.stop : input.stop - entry;
  if (!(reward > 0) || !(risk > 0)) return null;
  return risk / (risk + reward);
}

function atrCloseness(input: {
  side: Side;
  target: number;
  latestClose: number | null;
  dailyAtr: number | null;
}): number | null {
  const atr = input.dailyAtr;
  const last = input.latestClose;
  if (atr == null || !Number.isFinite(atr) || atr <= 0) return null;
  if (last == null || !Number.isFinite(last)) return null;
  const left = input.side === "long" ? input.target - last : last - input.target;
  const distance = left > 0 ? left : 0;
  return 1 / (1 + distance / atr);
}

function paceReading(input: {
  paceDate: string | null;
  nextPaceDate: string | null;
  through: string | null;
}): number | null {
  if (input.nextPaceDate) return 0;
  if (!input.paceDate || !input.through) return null;
  return input.paceDate > input.through ? 1 : 0;
}

function moodReading(input: { mood: MarketMoodName | null; side: Side }): number | null {
  if (!input.mood) return null;
  if (input.mood === "mixed") return 0.5;
  const agrees =
    (input.mood === "risk-on" && input.side === "long") ||
    (input.mood === "risk-off" && input.side === "short");
  return agrees ? 1 : 0;
}

export function formatRate(rate: number): string {
  const tenths = Math.round(rate * 1000) / 10;
  return Number.isInteger(tenths) ? `${tenths.toFixed(0)}%` : `${tenths.toFixed(1)}%`;
}

export function settledHitLabel(rates: SuggestionRates): string {
  const total = rates.reached + rates.notReached;
  if (rates.settled == null) return "Settled hit rate: no settled calls yet";
  return `Settled hit rate: ${formatRate(rates.settled)} (${rates.reached} of ${total} reached)`;
}

export function shareOfSuggestionsLabel(rates: SuggestionRates): string {
  const total = rates.reached + rates.notReached + rates.open;
  if (rates.share == null) return "Share of all suggestions: no suggestions yet";
  return `Share of all suggestions: ${formatRate(rates.share)} (${rates.reached} of ${total} reached)`;
}

export interface TrackedCall extends PublishedCall {
  status: CallStatus;
  /** Original pace date. Unchanged after the call is published. */
  paceDate: string | null;
  /** Set only after the original pace date passes without a target print. */
  nextPaceDate: string | null;
  latestClose: number | null;
  dailyAtr: number | null;
}

export function trackedCall(call: PublishedCall, status: CallStatus, pace?: Partial<PaceMark>): TrackedCall {
  return {
    ...call,
    status,
    paceDate: pace?.paceDate ?? null,
    nextPaceDate: pace?.nextPaceDate ?? null,
    latestClose: pace?.latestClose ?? null,
    dailyAtr: pace?.dailyAtr ?? null,
  };
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

export interface PaceMark {
  paceDate: string | null;
  nextPaceDate: string | null;
  latestClose: number | null;
  dailyAtr: number | null;
}

/**
 * A new pace date is the latest completed close, walked forward by the
 * remaining distance to the same target at the current daily ATR.
 * Reached calls, and calls whose original pace date has not passed, keep a
 * blank new date. A stop hit does not remove the new date.
 */
export function paceMark(input: {
  call: PublishedCall;
  daily: SessionPrint[];
  now: Date;
}): PaceMark {
  const daily = [...input.daily].sort((a, b) => a.date.localeCompare(b.date));
  const paceDate = paceDateFor(input.call, daily);
  const closeBar = latestCompletedClose(daily, input.now);
  const dailyAtr = closeBar ? atrThrough(daily, closeBar.date) : null;
  const latestClose = closeBar && Number.isFinite(closeBar.close) ? closeBar.close : null;
  const blank: PaceMark = { paceDate, nextPaceDate: null, latestClose, dailyAtr };
  if (!paceDate || !paceHasPassed(paceDate, input.now)) return blank;
  if (targetTradedLater(input.call, daily)) return blank;
  if (!closeBar || latestClose == null || dailyAtr == null) return blank;
  const byDate = new Map(daily.map((print) => [print.date, print]));
  if (gapThrough(input.call.asOf, closeBar.date, byDate) || closeBar.date < paceDate) return blank;
  const estimate = estimatedReach({
    asOf: `${closeBar.date}T15:00:00.000Z`,
    last: latestClose,
    target: input.call.target,
    atr: dailyAtr,
    atrTimeframe: "daily",
  });
  return { ...blank, nextPaceDate: estimate?.date ?? null };
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

function latestCompletedClose(daily: SessionPrint[], now: Date): SessionPrint | null {
  const clock = newYorkMinutes(now);
  if (!clock) return null;
  const completed = daily.filter(
    (bar) => bar.date < clock.date || (bar.date === clock.date && clock.minutes >= 16 * 60),
  );
  return completed[completed.length - 1] ?? null;
}

function atrThrough(daily: SessionPrint[], date: string): number | null {
  const index = daily.findIndex((print) => print.date === date);
  if (index < 1) return null;
  const bars: Bar[] = daily.slice(0, index + 1).map((print) => ({
    time: 0,
    open: print.close,
    high: print.high,
    low: print.low,
    close: print.close,
    volume: 0,
  }));
  const atr = averageTrueRange(bars, 14);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  return atr;
}

function targetTradedLater(call: PublishedCall, daily: SessionPrint[]): boolean {
  return daily.some((bar) => bar.date > call.asOf && tradedTarget(call, bar));
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
