import { price } from "@/lib/format";
import { levelFromCloses } from "./mood";
import type { IndicatorAlignment, IndicatorBoard, IndicatorRow, IndicatorTape } from "./types";

const USER_AGENT = "Mozilla/5.0 (compatible; Intratrade/1.0; decision-support)";
const RETURN_SESSIONS = 21;
const YEAR_SESSIONS = 252;
const MIN_HISTORY_WINDOWS = 30;
const MIN_PRIOR_ELECTIONS = 3;

export interface ClosePoint {
  /** New York session date, YYYY-MM-DD. */
  date: string;
  close: number;
}

export interface CpiPoint {
  year: number;
  month: number;
  value: number;
}

export interface IndicatorInput {
  spy: ClosePoint[] | null;
  yield10: ClosePoint[] | null;
  tip: ClosePoint[] | null;
  ief: ClosePoint[] | null;
  dollar: ClosePoint[] | null;
  oil: ClosePoint[] | null;
  cpi: CpiPoint[] | null;
}

/**
 * US general election day: the Tuesday after the first Monday in November of an even year.
 * The date is the calendar rule. The returns around it come from the tape, not from a stored table.
 */
export function generalElectionDate(year: number): string {
  const weekday = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstMonday = 1 + ((1 - weekday + 7) % 7);
  const day = firstMonday + 1;
  return `${year}-11-${String(day).padStart(2, "0")}`;
}

export function buildIndicatorBoard(input: IndicatorInput): IndicatorBoard {
  const omitted: string[] = [];
  const spy = dailySeries(input.spy);
  if (!spy) {
    omitted.push("S&P 500 (SPY)");
    return { tape: null, rows: [], omitted };
  }
  const tape = tapeFrom(spy);
  if (!tape) {
    omitted.push("S&P 500 10-session average (SPY)");
    return { tape: null, rows: [], omitted };
  }

  const rows: IndicatorRow[] = [];
  pushReturnRow(rows, omitted, spy, tape);
  pushElectionRow(rows, omitted, spy, tape);
  pushCpiRow(rows, omitted, input.cpi, tape);
  pushYieldRow(rows, omitted, input.yield10, tape);
  pushYearRow(rows, omitted, spy, tape);
  pushTipsRow(rows, omitted, input.tip, input.ief, tape);
  pushHeadwindRow(rows, omitted, "Dollar", "Dollar (UUP)", input.dollar, tape);
  pushHeadwindRow(rows, omitted, "Oil", "Oil (CL=F)", input.oil, tape);
  return { tape, rows, omitted };
}

export async function loadIndicators(): Promise<IndicatorBoard> {
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const [spy, yield10, tip, ief, dollar, oil, cpi] = await Promise.all([
    fetchYahooCloses("SPY", `interval=1d&period1=631152000&period2=${period2}`),
    fetchYahooCloses("^TNX", "interval=1d&range=6mo"),
    fetchYahooCloses("TIP", "interval=1d&range=6mo"),
    fetchYahooCloses("IEF", "interval=1d&range=6mo"),
    fetchYahooCloses("UUP", "interval=1d&range=6mo"),
    fetchYahooCloses("CL=F", "interval=1d&range=6mo"),
    fetchCpi(),
  ]);
  return buildIndicatorBoard({ spy, yield10, tip, ief, dollar, oil, cpi });
}

function pushReturnRow(
  rows: IndicatorRow[],
  omitted: string[],
  spy: ClosePoint[],
  tape: IndicatorTape,
): void {
  const windows = rollingPercent(spy, RETURN_SESSIONS);
  if (windows.length < MIN_HISTORY_WINDOWS) {
    omitted.push("S&P 500 21-session history (SPY)");
    return;
  }
  const current = windows[windows.length - 1];
  const average = mean(windows);
  const low = Math.min(...windows);
  const high = Math.max(...windows);
  const year = spy[0].date.slice(0, 4);
  const points = sideOf(roundTo(current, 1));
  rows.push({
    factor: "S&P 500",
    period: `${RETURN_SESSIONS} sessions`,
    statistic: `${signedPercent(current)} · avg ${signedPercent(average)} since ${year} · range ${signedPercent(low)} to ${signedPercent(high)}`,
    alignment: align(tape, points),
    points,
  });
}

function pushYearRow(
  rows: IndicatorRow[],
  omitted: string[],
  spy: ClosePoint[],
  tape: IndicatorTape,
): void {
  const change = changeOver(spy, YEAR_SESSIONS);
  if (!change) {
    omitted.push("S&P 500 252-session return (SPY)");
    return;
  }
  const points = sideOf(roundTo(change.percent, 1));
  rows.push({
    factor: "S&P 500",
    period: `${YEAR_SESSIONS} sessions`,
    statistic: signedPercent(change.percent),
    alignment: align(tape, points),
    points,
  });
}

function pushElectionRow(
  rows: IndicatorRow[],
  omitted: string[],
  spy: ClosePoint[],
  tape: IndicatorTape,
): void {
  const name = "Election windows (SPY)";
  const lastDate = spy[spy.length - 1].date;
  const year = latestElectionYear(lastDate);
  const current = electionWindow(spy, year);
  if (!current || current.span < 1) {
    omitted.push(name);
    return;
  }
  const priors: number[] = [];
  for (let prior = year - 2; prior >= 1994; prior -= 2) {
    const window = electionWindow(spy, prior);
    if (!window || window.spanEnd == null) continue;
    const end = window.preIndex + current.span;
    if (end >= spy.length) continue;
    const percent = percentChange(spy[window.preIndex].close, spy[end].close);
    if (percent == null) continue;
    priors.push(percent);
  }
  if (priors.length < MIN_PRIOR_ELECTIONS || current.percent == null) {
    omitted.push(name);
    return;
  }
  const average = mean(priors);
  const gap = roundTo(current.percent, 1) - roundTo(average, 1);
  const points = sideOf(gap);
  rows.push({
    factor: "S&P after elections",
    period: spanLabel(spy[current.preIndex].date, spy[spy.length - 1].date),
    statistic: `${signedPercent(current.percent)} over ${current.span} sessions · avg ${signedPercent(average)} after ${priors.length} elections · range ${signedPercent(Math.min(...priors))} to ${signedPercent(Math.max(...priors))}`,
    alignment: align(tape, points),
    points,
  });
}

function pushYieldRow(
  rows: IndicatorRow[],
  omitted: string[],
  series: ClosePoint[] | null,
  tape: IndicatorTape,
): void {
  const name = "10-year yield (^TNX)";
  const daily = dailySeries(series);
  const change = daily ? changeOver(daily, RETURN_SESSIONS) : null;
  if (!daily || !change) {
    omitted.push(name);
    return;
  }
  const from = roundTo(change.from, 2);
  const to = roundTo(change.to, 2);
  const changePoints = roundTo(to - from, 2);
  const points = invert(sideOf(changePoints));
  rows.push({
    factor: "10-year yield",
    period: `${RETURN_SESSIONS} sessions`,
    statistic: `${price(to)}% from ${price(from)}% (${signedPoints(changePoints)})`,
    alignment: align(tape, points),
    points,
  });
}

function pushCpiRow(
  rows: IndicatorRow[],
  omitted: string[],
  cpi: CpiPoint[] | null,
  tape: IndicatorTape,
): void {
  const name = "CPI (BLS CUUR0000SA0)";
  const latest = cpi ? latestCpi(cpi) : null;
  if (!latest) {
    omitted.push(name);
    return;
  }
  const yoy = percentChange(latest.yearAgo, latest.value);
  const prior = percentChange(latest.twoYearsAgo, latest.yearAgo);
  if (yoy == null || prior == null) {
    omitted.push(name);
    return;
  }
  const delta = roundTo(roundTo(yoy, 1) - roundTo(prior, 1), 1);
  const month = monthName(latest.month);
  const points = invert(sideOf(delta));
  rows.push({
    factor: "CPI",
    period: `12 months to ${month} ${latest.year}`,
    statistic: `${signedPercent(yoy)} year over year · prior year ${signedPercent(prior)} (${signedPoints(delta, 1)})`,
    alignment: align(tape, points),
    points,
  });
}

function pushTipsRow(
  rows: IndicatorRow[],
  omitted: string[],
  tip: ClosePoint[] | null,
  ief: ClosePoint[] | null,
  tape: IndicatorTape,
): void {
  const name = "TIPS versus Treasuries (TIP, IEF)";
  const tipChange = dailySeries(tip) ? changeOver(dailySeries(tip) as ClosePoint[], RETURN_SESSIONS) : null;
  const iefChange = dailySeries(ief) ? changeOver(dailySeries(ief) as ClosePoint[], RETURN_SESSIONS) : null;
  if (!tipChange || !iefChange) {
    omitted.push(name);
    return;
  }
  const spread = roundTo(roundTo(tipChange.percent, 1) - roundTo(iefChange.percent, 1), 1);
  const points = invert(sideOf(spread));
  rows.push({
    factor: "TIPS vs Treasuries",
    period: `${RETURN_SESSIONS} sessions`,
    statistic: `TIP ${signedPercent(tipChange.percent)} · IEF ${signedPercent(iefChange.percent)} · spread ${signedPoints(spread, 1)}`,
    alignment: align(tape, points),
    points,
  });
}

function pushHeadwindRow(
  rows: IndicatorRow[],
  omitted: string[],
  factor: string,
  missingName: string,
  series: ClosePoint[] | null,
  tape: IndicatorTape,
): void {
  const daily = dailySeries(series);
  const change = daily ? changeOver(daily, RETURN_SESSIONS) : null;
  if (!change) {
    omitted.push(missingName);
    return;
  }
  const points = invert(sideOf(roundTo(change.percent, 1)));
  rows.push({
    factor,
    period: `${RETURN_SESSIONS} sessions`,
    statistic: signedPercent(change.percent),
    alignment: align(tape, points),
    points,
  });
}

interface ElectionWindow {
  preIndex: number;
  span: number;
  spanEnd: number | null;
  percent: number | null;
}

function electionWindow(spy: ClosePoint[], year: number): ElectionWindow | null {
  const election = generalElectionDate(year);
  const electionIndex = spy.findIndex((point) => point.date >= election);
  if (electionIndex <= 0) return null;
  const preIndex = electionIndex - 1;
  const span = spy.length - 1 - preIndex;
  const percent = percentChange(spy[preIndex].close, spy[spy.length - 1].close);
  return { preIndex, span, spanEnd: spy.length - 1, percent };
}

function latestElectionYear(lastDate: string): number {
  let year = Number(lastDate.slice(0, 4));
  if (year % 2 !== 0) year -= 1;
  if (generalElectionDate(year) > lastDate) year -= 2;
  return year;
}

function latestCpi(
  points: CpiPoint[],
): { year: number; month: number; value: number; yearAgo: number; twoYearsAgo: number } | null {
  const sorted = points
    .filter((point) => point.month >= 1 && point.month <= 12 && point.value > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month);
  const latest = sorted[sorted.length - 1];
  if (!latest) return null;
  const yearAgo = sorted.find((point) => point.year === latest.year - 1 && point.month === latest.month);
  const twoYearsAgo = sorted.find((point) => point.year === latest.year - 2 && point.month === latest.month);
  if (!yearAgo || !twoYearsAgo) return null;
  return {
    year: latest.year,
    month: latest.month,
    value: latest.value,
    yearAgo: yearAgo.value,
    twoYearsAgo: twoYearsAgo.value,
  };
}

function tapeFrom(spy: ClosePoint[]): IndicatorTape | null {
  const closes = spy.map((point) => point.close);
  const last = closes[closes.length - 1];
  const level = levelFromCloses(last, closes);
  if (!level) return null;
  const relation = level.last > level.average ? "above" : level.last < level.average ? "below" : "equal to";
  return {
    side: level.supportive ? "up" : "down",
    last: level.last,
    average: level.average,
    relation,
  };
}

function dailySeries(points: ClosePoint[] | null): ClosePoint[] | null {
  if (!points || points.length === 0) return null;
  const byDate = new Map<string, number>();
  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !Number.isFinite(point.close) || point.close <= 0) continue;
    byDate.set(point.date, point.close);
  }
  const series = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, close]) => ({ date, close }));
  if (!looksDaily(series)) return null;
  return series;
}

function looksDaily(points: ClosePoint[]): boolean {
  if (points.length < 10) return false;
  let gapDays = 0;
  for (let index = 1; index < points.length; index += 1) {
    gapDays += (Date.parse(`${points[index].date}T00:00:00Z`) - Date.parse(`${points[index - 1].date}T00:00:00Z`)) / 86_400_000;
  }
  return gapDays / (points.length - 1) < 5;
}

function changeOver(
  points: ClosePoint[],
  sessions: number,
): { from: number; to: number; percent: number } | null {
  if (points.length <= sessions) return null;
  const from = points[points.length - 1 - sessions].close;
  const to = points[points.length - 1].close;
  const percent = percentChange(from, to);
  if (percent == null) return null;
  return { from, to, percent };
}

function rollingPercent(points: ClosePoint[], sessions: number): number[] {
  const changes: number[] = [];
  for (let index = sessions; index < points.length; index += 1) {
    const percent = percentChange(points[index - sessions].close, points[index].close);
    if (percent != null) changes.push(percent);
  }
  return changes;
}

function percentChange(from: number, to: number): number | null {
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A rise in the series lines up with an up tape. */
function sideOf(value: number): "up" | "down" | "flat" {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/** A rise in the series lines up with a down tape (tighter yields, hotter inflation, a stronger dollar, higher oil). */
function invert(side: "up" | "down" | "flat"): "up" | "down" | "flat" {
  if (side === "up") return "down";
  if (side === "down") return "up";
  return "flat";
}

function align(tape: IndicatorTape, factor: "up" | "down" | "flat"): IndicatorAlignment {
  if (factor === "flat") return "against";
  return factor === tape.side ? "with" : "against";
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function signedPercent(value: number): string {
  const rounded = roundTo(value, 1);
  const body = Math.abs(rounded).toFixed(1);
  if (rounded > 0) return `+${body}%`;
  if (rounded < 0) return `−${body}%`;
  return "0.0%";
}

function signedPoints(value: number, digits = 2): string {
  const rounded = roundTo(value, digits);
  const body = Math.abs(rounded).toFixed(digits);
  if (rounded > 0) return `+${body} pt`;
  if (rounded < 0) return `−${body} pt`;
  return "0.00 pt";
}

function spanLabel(from: string, to: string): string {
  const start = shortDate(from);
  const end = shortDate(to);
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${start.replace(`, ${from.slice(0, 4)}`, "")}–${end}`;
  }
  return `${start}–${end}`;
}

function shortDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

function monthName(month: number): string {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] ?? String(month);
}

async function fetchYahooCloses(symbol: string, params: string): Promise<ClosePoint[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}&includePrePost=false`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      chart?: {
        error?: { description?: string } | null;
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = payload.chart?.result?.[0];
    if (payload.chart?.error || !result?.timestamp?.length) return null;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const points: ClosePoint[] = [];
    for (let index = 0; index < result.timestamp.length; index += 1) {
      const close = closes[index];
      if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
      points.push({ date: nyDate(result.timestamp[index] * 1000), close });
    }
    return points.length > 0 ? points : null;
  } catch {
    return null;
  }
}

async function fetchCpi(): Promise<CpiPoint[] | null> {
  try {
    const end = new Date().getUTCFullYear();
    const response = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        seriesid: ["CUUR0000SA0"],
        startyear: String(end - 3),
        endyear: String(end),
      }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      status?: string;
      Results?: { series?: Array<{ data?: Array<{ year?: string; period?: string; value?: string }> }> };
    };
    if (payload.status !== "REQUEST_SUCCEEDED") return null;
    const data = payload.Results?.series?.[0]?.data;
    if (!Array.isArray(data)) return null;
    const points: CpiPoint[] = [];
    for (const row of data) {
      const month = /^M(\d{2})$/.exec(row.period ?? "");
      const year = Number(row.year);
      const value = Number(row.value);
      if (!month || !Number.isInteger(year) || !Number.isFinite(value) || value <= 0) continue;
      const monthNumber = Number(month[1]);
      if (monthNumber < 1 || monthNumber > 12) continue;
      points.push({ year, month: monthNumber, value });
    }
    return points.length > 0 ? points : null;
  } catch {
    return null;
  }
}

function nyDate(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
