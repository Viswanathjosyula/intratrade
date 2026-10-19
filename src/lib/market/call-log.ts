import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rankIdeas } from "./engine";
import {
  levelsConfirmed,
  newYorkMinutes,
  scoreCall,
  mergeCalls,
  paceMark,
  trackedCall,
  type IntradayPrint,
  type PublishedCall,
  type SessionPrint,
  type TrackedCall,
} from "./calls";
import type { Bar } from "./patterns";
import { newYorkSessionDate } from "./reach";
import { DEFAULT_RISK, type MarketSession } from "./types";

const LOG_PATH = join(process.cwd(), "src/data/calls.json");
const USER_AGENT = "Mozilla/5.0 (compatible; Intratrade/1.0; decision-support)";

export interface TrackedBook {
  calls: TrackedCall[];
  /** Latest New York session date present on every symbol that returned bars. */
  through: string | null;
  /** True when at least one symbol's bars could not be read. Those rows stay open. */
  incomplete: boolean;
}

interface YahooChart {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

export function readCallLog(): PublishedCall[] {
  const parsed = JSON.parse(readFileSync(LOG_PATH, "utf8")) as { calls?: unknown };
  if (!Array.isArray(parsed.calls)) return [];
  return parsed.calls.filter(isPublishedCall);
}

export function writeCallLog(calls: PublishedCall[]): void {
  const next = `${JSON.stringify({ calls }, null, 2)}\n`;
  const current = readFileSync(LOG_PATH, "utf8");
  if (current === next) return;
  const tmp = `${LOG_PATH}.next`;
  writeFileSync(tmp, next);
  renameSync(tmp, LOG_PATH);
}

/** Append live consider calls. Sample tapes are ignored. Same symbol, side, and target are not repeated. */
export function appendLiveConsiders(existing: PublishedCall[], session: MarketSession): PublishedCall[] {
  if (session.source !== "live" || session.fallbackError) return existing;
  const asOf = newYorkSessionDate(session.asOf);
  if (!asOf) return existing;
  const incoming = rankIdeas(session.snapshots, DEFAULT_RISK)
    .filter((idea) => idea.stance === "consider")
    .map((idea) => ({
      symbol: idea.symbol,
      side: idea.side,
      target: roundCents(idea.target),
      stop: roundCents(idea.stop),
      asOf,
    }));
  return mergeCalls(existing, incoming);
}

export async function trackBook(session: MarketSession): Promise<TrackedBook> {
  const existing = readCallLog();
  const calls = appendLiveConsiders(existing, session);
  if (calls.length !== existing.length) writeCallLog(calls);
  return scorePublishedCalls(calls);
}

export async function scorePublishedCalls(calls: PublishedCall[]): Promise<TrackedBook> {
  const symbols = [...new Set(calls.map((call) => call.symbol))];
  const dailyBySymbol = new Map<string, SessionPrint[] | null>();
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        dailyBySymbol.set(symbol, await fetchDailySessions(symbol));
      } catch {
        dailyBySymbol.set(symbol, null);
      }
    }),
  );

  const intradayNeeded = new Set<string>();
  const preliminary = calls.map((call) => {
    const daily = dailyBySymbol.get(call.symbol);
    if (!daily) return { call, outcome: { status: "open" as const } };
    const outcome = scoreCall({ call, daily, now: new Date() });
    if (outcome.needsIntradayOn) intradayNeeded.add(call.symbol);
    return { call, outcome };
  });

  const intradayBySymbol = new Map<string, IntradayPrint[] | null>();
  await Promise.all(
    [...intradayNeeded].map(async (symbol) => {
      try {
        intradayBySymbol.set(symbol, await fetchIntradaySessions(symbol));
      } catch {
        intradayBySymbol.set(symbol, null);
      }
    }),
  );

  let incomplete = symbols.some((symbol) => {
    const daily = dailyBySymbol.get(symbol);
    return !daily || daily.length === 0;
  });
  const lastBySymbol = new Map<string, string>();
  const tracked: TrackedCall[] = preliminary.map(({ call, outcome }) => {
    const daily = dailyBySymbol.get(call.symbol);
    if (!daily || daily.length === 0) return trackedCall(call, "open");
    const last = daily[daily.length - 1]?.date;
    if (last) lastBySymbol.set(call.symbol, last);
    const now = new Date();
    if (!outcome.needsIntradayOn) return trackedCall(call, outcome.status, paceMark({ call, daily, now }));
    const intraday = intradayBySymbol.get(call.symbol);
    if (!intraday) {
      incomplete = true;
      return trackedCall(call, "open");
    }
    const status = scoreCall({ call, daily, intraday, now }).status;
    return trackedCall(call, status, paceMark({ call, daily, now }));
  });

  const lastDates = [...lastBySymbol.values()];
  const through =
    lastDates.length === 0
      ? null
      : lastDates.reduce((earliest, date) => (date < earliest ? date : earliest));

  return { calls: tracked, through, incomplete };
}

/** Drop seed rows whose as-of session is missing or whose close is not between the levels. */
export async function confirmSeeds(seeds: PublishedCall[]): Promise<{
  kept: PublishedCall[];
  skipped: PublishedCall[];
}> {
  const kept: PublishedCall[] = [];
  const skipped: PublishedCall[] = [];
  const cache = new Map<string, SessionPrint[]>();
  for (const seed of seeds) {
    let daily = cache.get(seed.symbol);
    if (!daily) {
      daily = await fetchDailySessions(seed.symbol);
      cache.set(seed.symbol, daily);
    }
    if (levelsConfirmed(seed, daily)) kept.push(seed);
    else skipped.push(seed);
  }
  return { kept: mergeCalls([], kept), skipped };
}

export async function fetchDailySessions(symbol: string): Promise<SessionPrint[]> {
  const payload = await fetchChart(symbol, "1d", "6mo");
  return barsFromChart(payload)
    .map((bar) => {
      const date = newYorkSessionDate(new Date(bar.time * 1000).toISOString());
      if (!date) return null;
      return { date, high: bar.high, low: bar.low, close: bar.close };
    })
    .filter((bar): bar is SessionPrint => bar !== null);
}

export async function fetchIntradaySessions(symbol: string): Promise<IntradayPrint[]> {
  const payload = await fetchChart(symbol, "5m", "1mo");
  const prints: IntradayPrint[] = [];
  for (const bar of barsFromChart(payload)) {
    const clock = newYorkMinutes(new Date(bar.time * 1000));
    if (!clock) continue;
    if (clock.minutes < 9 * 60 + 30 || clock.minutes >= 16 * 60) continue;
    prints.push({ date: clock.date, time: bar.time, high: bar.high, low: bar.low });
  }
  return prints;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPublishedCall(value: unknown): value is PublishedCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Partial<PublishedCall>;
  return (
    typeof call.symbol === "string" &&
    (call.side === "long" || call.side === "short") &&
    typeof call.target === "number" &&
    Number.isFinite(call.target) &&
    typeof call.stop === "number" &&
    Number.isFinite(call.stop) &&
    typeof call.asOf === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(call.asOf)
  );
}

async function fetchChart(symbol: string, interval: string, range: string): Promise<YahooChart> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance chart HTTP ${response.status} for ${symbol} ${interval}`);
  }
  const payload = (await response.json()) as YahooChart;
  if (payload.chart?.error) {
    throw new Error(
      `Yahoo Finance chart error for ${symbol} ${interval}: ${payload.chart.error.description ?? "unknown"}`,
    );
  }
  if (!payload.chart?.result?.[0]?.timestamp?.length) {
    throw new Error(`Yahoo Finance chart for ${symbol} ${interval} returned no bars`);
  }
  return payload;
}

function barsFromChart(payload: YahooChart): Bar[] {
  const result = payload.chart.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) return [];
  const bars: Bar[] = [];
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];
    if (high == null || low == null || close == null || !Number.isFinite(close)) continue;
    bars.push({
      time: result.timestamp[index],
      open: close,
      high,
      low,
      close,
      volume: 0,
    });
  }
  return bars;
}
