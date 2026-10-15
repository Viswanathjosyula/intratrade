import { sessionStamp } from "@/lib/format";
import { analyzeTape, choosePattern, type Bar } from "./patterns";
import type { EarningsPillar, MarketSession, NewsPillar, Sentiment, Snapshot } from "./types";

/** Liquid US names. The book keeps the ones whose tape can be read. */
const UNIVERSE = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "TSLA",
  "AMD",
  "AVGO",
  "NFLX",
  "JPM",
  "XOM",
  "BA",
  "DIS",
  "MU",
  "COST",
  "WMT",
  "CRM",
  "ORCL",
  "QCOM",
] as const;

const CACHE_MS = 90_000;
const USER_AGENT = "Mozilla/5.0 (compatible; Intratrade/1.0; decision-support)";

let cache: { at: number; session: MarketSession } | null = null;

interface YahooAuth {
  cookie: string;
  crumb: string;
}

/**
 * Public quotes with no API key: Yahoo Finance charts and headlines, Nasdaq
 * earnings surprise, and Yahoo's reported quarterly revenue.
 * `apiKey` is accepted so a paid vendor can be branched in later. It is not
 * required, and it is not sent to Yahoo.
 */
export async function loadPublicSession(options?: { apiKey?: string }): Promise<MarketSession> {
  if (options?.apiKey && process.env.MARKET_DATA_VENDOR === "custom") {
    throw new Error(
      "MARKET_DATA_VENDOR=custom is set, but that paid adapter is not implemented. Unset MARKET_DATA_VENDOR to use Yahoo Finance and Nasdaq.",
    );
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.session;

  const session = await buildSession();
  cache = { at: Date.now(), session };
  return session;
}

async function buildSession(): Promise<MarketSession> {
  let auth: YahooAuth | null = null;
  let authError: string | null = null;
  try {
    auth = await yahooAuth();
  } catch (error) {
    authError = errorMessage(error);
  }

  const loaded = await mapPool(UNIVERSE, 4, async (symbol) => {
    try {
      return await loadSymbol(symbol, auth);
    } catch (error) {
      return { symbol, error: errorMessage(error) };
    }
  });

  const snapshots: Snapshot[] = [];
  const quoteTimes: number[] = [];
  const failures: string[] = [];
  for (const item of loaded) {
    if ("snapshot" in item && item.snapshot && "quotedAtMs" in item) {
      snapshots.push(item.snapshot);
      quoteTimes.push(item.quotedAtMs);
    } else if ("error" in item && item.error && "symbol" in item) {
      failures.push(`${item.symbol}: ${item.error}`);
    }
  }

  if (snapshots.length === 0) {
    const sample = failures.slice(0, 3).join(" | ");
    throw new Error(
      `Yahoo Finance returned no usable US stock tapes (${failures.length} symbols failed). ${sample}`,
    );
  }

  const asOfMs = quoteTimes.length > 0 ? Math.max(...quoteTimes) : Date.now();
  const asOf = new Date(asOfMs).toISOString();
  const nowMs = Date.now();
  const delayLabel = describeFeed(asOfMs, nowMs);
  const priorClose = showingPriorClose(asOfMs, nowMs);
  const calendar = await calendarNote(nyDate(asOfMs));
  const skipped =
    failures.length > 0
      ? ` ${failures.length} symbols were skipped because their feed failed (${failures
          .slice(0, 2)
          .join("; ")}).`
      : "";
  const authNote = authError
    ? ` Yahoo earnings crumb failed (${authError}). Revenue uses the last successful Yahoo response per symbol; EPS surprise still comes from Nasdaq when that call works.`
    : "";

  return {
    asOf,
    market: "US stocks",
    source: "live",
    feed: "Yahoo Finance",
    delayLabel,
    note: {
      title: priorClose
        ? "Previous regular session"
        : marketIsClosed(asOfMs, nowMs)
          ? "Cash session is closed"
          : "Cash session is open",
      detail: `${
        priorClose
          ? "Today's chart does not have a regular-session bar yet, so these prices are the previous close."
          : marketIsClosed(asOfMs, nowMs)
            ? "Prices are the regular-session print, not after-hours trading."
            : "Prices are the latest Yahoo Finance regular-session bars."
      } ${calendar}${skipped}${authNote} Nothing on this desk sends an order.`,
    },
    snapshots,
  };
}

async function loadSymbol(
  symbol: string,
  auth: YahooAuth | null,
): Promise<{ snapshot: Snapshot; quotedAtMs: number }> {
  const [dailyChart, intradayChart, headline, fundamentals, nasdaq] = await Promise.all([
    fetchChart(symbol, "1d", "6mo"),
    fetchChart(symbol, "5m", "5d"),
    fetchHeadline(symbol).catch(() => null),
    auth
      ? fetchFundamentals(symbol, auth).catch(() => null)
      : Promise.resolve(null),
    fetchNasdaqEarnings(symbol).catch(() => null),
  ]);

  const intraday = sessionBarsForTape(barsFromChart(intradayChart));
  const daily = dailyBarsForSession(barsFromChart(dailyChart), intraday);
  const tape = analyzeTape(daily, intraday);
  if (!tape || intraday.length === 0) {
    throw new Error(`${symbol}: Yahoo chart did not include a regular session`);
  }
  const setup = choosePattern(daily, tape);
  const meta = chartMeta(dailyChart);
  const sessionDate = nyDate(intraday[intraday.length - 1].time * 1000);
  const metaMs = meta.regularMarketTime ? meta.regularMarketTime * 1000 : 0;
  const metaDate = metaMs ? nyDate(metaMs) : sessionDate;
  const priorClose = metaDate !== sessionDate;
  const quoteMs = priorClose ? intraday[intraday.length - 1].time * 1000 : metaMs || intraday[intraday.length - 1].time * 1000;
  const sessionClose = daily.length > 0 ? daily[daily.length - 1].close : tape.last;
  const last = priorClose
    ? sessionClose
    : typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice)
      ? meta.regularMarketPrice
      : tape.last;
  const earnings = toEarnings(fundamentals, nasdaq, sessionDate);
  const news = headline ?? quietNews(symbol, new Date(quoteMs).toISOString());

  return {
    quotedAtMs: quoteMs,
    snapshot: {
      symbol,
      name: meta.longName || meta.shortName || symbol,
      last: round(last),
      vwap: round(tape.vwap),
      vwapEvent: tape.vwapEvent,
      openingRangeHigh: round(tape.openingRangeHigh),
      openingRangeLow: round(tape.openingRangeLow),
      openingRangeEvent: tape.openingRangeEvent,
      atr: setup.atr,
      atrTimeframe: setup.atrTimeframe,
      relativeVolume: Math.round(tape.relativeVolume * 10) / 10,
      measuredTarget: setup.measuredTarget,
      news,
      earnings,
      pattern: setup.pattern,
    },
  };
}

function quietNews(symbol: string, publishedAt: string): NewsPillar {
  return {
    catalyst: "No headline",
    headline: `Yahoo Finance returned no recent headline for ${symbol}.`,
    source: "Yahoo Finance",
    publishedAt,
    sentiment: "neutral",
  };
}

interface ChartMeta {
  regularMarketTime?: number;
  regularMarketPrice?: number;
  longName?: string;
  shortName?: string;
}

function chartMeta(payload: YahooChart): ChartMeta {
  return payload.chart.result?.[0]?.meta ?? {};
}

async function fetchChart(symbol: string, interval: string, range: string): Promise<YahooChart> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const payload = (await getJson(url)) as YahooChart;
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
  if (!result?.timestamp || !result.indicators?.quote?.[0]) return [];
  const quote = result.indicators.quote[0];
  const bars: Bar[] = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i] ?? 0;
    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    bars.push({ time: result.timestamp[i], open, high, low, close, volume: volume ?? 0 });
  }
  return bars;
}

const MIN_REGULAR_BARS = 3;

/**
 * Regular-session 5-minute bars for the tape. A session that has not printed
 * enough bars yet (the cash open) is skipped in favor of the previous close.
 */
export function sessionBarsForTape(bars: Bar[]): Bar[] {
  const byDate = new Map<string, Bar[]>();
  for (const bar of bars) {
    const clock = nyClock(bar.time * 1000);
    if (clock.minutes < 9 * 60 + 30 || clock.minutes >= 16 * 60) continue;
    if (clock.minutes % 5 !== 0) continue;
    const list = byDate.get(clock.date) ?? [];
    list.push(bar);
    byDate.set(clock.date, list);
  }
  const dates = [...byDate.keys()].sort();
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const session = byDate.get(dates[index]) ?? [];
    if (session.length >= MIN_REGULAR_BARS) return session;
  }
  return [];
}

/** Drop a newer daily bar when the tape is still the previous regular session. */
export function dailyBarsForSession(daily: Bar[], session: Bar[]): Bar[] {
  if (session.length === 0) return daily;
  const sessionDate = nyDate(session[session.length - 1].time * 1000);
  const trimmed = daily.filter((bar) => nyDate(bar.time * 1000) <= sessionDate);
  return trimmed.length > 0 ? trimmed : daily;
}

async function fetchHeadline(symbol: string): Promise<NewsPillar | null> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance news RSS HTTP ${response.status} for ${symbol}`);
  }
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((match) => match[1]);
  if (items.length === 0) return null;
  const symbolHit = items.find((item) => {
    const blob = `${readTag(item, "title") ?? ""} ${readTag(item, "description") ?? ""}`;
    return new RegExp(`\\b${symbol}\\b`, "i").test(decodeXml(blob));
  });
  const item = symbolHit ?? items[0];
  const headline = decodeXml(readTag(item, "title") ?? "");
  const description = decodeXml(readTag(item, "description") ?? "");
  const pubDate = readTag(item, "pubDate");
  if (!headline) return null;
  const published = pubDate ? new Date(pubDate) : new Date();
  return {
    catalyst: headline.split(/[:|–—-]/)[0]?.trim().slice(0, 110) || "Latest headline",
    headline,
    source: "Yahoo Finance",
    publishedAt: Number.isNaN(published.getTime()) ? new Date().toISOString() : published.toISOString(),
    sentiment: sentimentOf(`${headline} ${description}`),
  };
}

function sentimentOf(text: string): Sentiment {
  const haystack = text.toLowerCase();
  const positive = countTerms(haystack, POSITIVE_TERMS);
  const negative = countTerms(haystack, NEGATIVE_TERMS);
  if (positive > 0 && negative > 0) return "mixed";
  if (positive > 0) return "positive";
  if (negative > 0) return "negative";
  return "neutral";
}

function countTerms(text: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}

const POSITIVE_TERMS = [
  "beats",
  "beat estimates",
  "upgrade",
  "upgraded",
  "raises guidance",
  "raise guidance",
  "record",
  "surge",
  "surges",
  "jumps",
  "rally",
  "rallies",
  "outperform",
  "buyback",
  "approved",
  "approval",
  "tops estimates",
  "strong demand",
];

const NEGATIVE_TERMS = [
  "misses",
  "miss estimates",
  "downgrade",
  "downgraded",
  "cuts guidance",
  "cut guidance",
  "lawsuit",
  "probe",
  "investigation",
  "recall",
  "plunge",
  "plunges",
  "warning",
  "layoffs",
  "fraud",
  "subpoena",
  "weak demand",
  "slump",
  "slumps",
];

interface Fundamentals {
  revenueActual: number | null;
  period: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  quarterEnd: string | null;
}

async function fetchFundamentals(symbol: string, auth: YahooAuth): Promise<Fundamentals | null> {
  const url = new URL(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`);
  url.searchParams.set("modules", "earnings,earningsHistory");
  url.searchParams.set("crumb", auth.crumb);
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Cookie: auth.cookie, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance quoteSummary HTTP ${response.status} for ${symbol}`);
  }
  const payload = (await response.json()) as {
    quoteSummary?: {
      error?: { description?: string };
      result?: Array<{
        earnings?: {
          financialsChart?: {
            quarterly?: Array<{ date?: string; revenue?: { raw?: number } }>;
          };
        };
        earningsHistory?: {
          history?: Array<{
            epsActual?: { raw?: number };
            epsEstimate?: { raw?: number };
            quarter?: { fmt?: string };
            period?: string;
          }>;
        };
      }>;
    };
  };
  if (payload.quoteSummary?.error) {
    throw new Error(
      `Yahoo Finance quoteSummary error for ${symbol}: ${payload.quoteSummary.error.description ?? "unknown"}`,
    );
  }
  const result = payload.quoteSummary?.result?.[0];
  if (!result) return null;
  const quarterly = result.earnings?.financialsChart?.quarterly ?? [];
  const latestRevenue = quarterly[quarterly.length - 1];
  const history = result.earningsHistory?.history ?? [];
  const latestEps = history.find((row) => row.period === "-1q") ?? history[history.length - 1];
  return {
    revenueActual: latestRevenue?.revenue?.raw ?? null,
    period: latestRevenue?.date ?? null,
    epsActual: latestEps?.epsActual?.raw ?? null,
    epsEstimate: latestEps?.epsEstimate?.raw ?? null,
    quarterEnd: latestEps?.quarter?.fmt ?? null,
  };
}

interface NasdaqPrint {
  reportedAt: string;
  period: string;
  epsActual: number;
  epsEstimate: number;
}

async function fetchNasdaqEarnings(symbol: string): Promise<NasdaqPrint | null> {
  const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Nasdaq earnings-surprise HTTP ${response.status} for ${symbol}`);
  }
  const payload = (await response.json()) as {
    data?: {
      earningsSurpriseTable?: {
        rows?: Array<{
          fiscalQtrEnd?: string;
          dateReported?: string;
          eps?: number | string;
          consensusForecast?: number | string;
        }>;
      };
    };
  };
  const row = payload.data?.earningsSurpriseTable?.rows?.[0];
  if (!row?.dateReported || row.eps == null || row.consensusForecast == null) return null;
  const epsActual = Number(row.eps);
  const epsEstimate = Number(row.consensusForecast);
  const reportedAt = parseUsDate(row.dateReported);
  if (!reportedAt || !Number.isFinite(epsActual) || !Number.isFinite(epsEstimate) || epsEstimate === 0) {
    return null;
  }
  return {
    reportedAt,
    period: row.fiscalQtrEnd ? `Quarter ended ${row.fiscalQtrEnd}` : "Latest reported quarter",
    epsActual,
    epsEstimate,
  };
}

function toEarnings(
  fundamentals: Fundamentals | null,
  nasdaq: NasdaqPrint | null,
  sessionDate: string,
): EarningsPillar {
  const epsActual = nasdaq?.epsActual ?? fundamentals?.epsActual ?? null;
  const epsEstimate = nasdaq?.epsEstimate ?? fundamentals?.epsEstimate ?? null;
  const reportedAt = nasdaq?.reportedAt ?? fundamentals?.quarterEnd ?? sessionDate;
  const period = nasdaq?.period ?? fundamentals?.period ?? "Latest reported quarter";
  return {
    period,
    reportedAt,
    revenueActual: fundamentals?.revenueActual ?? 0,
    revenueEstimate: null,
    epsActual,
    epsEstimate,
    surpriseBasis: epsActual != null && epsEstimate != null ? "eps" : "revenue",
    recencySessions: businessDaysBetween(reportedAt, sessionDate),
  };
}

async function yahooAuth(): Promise<YahooAuth> {
  const seed = await fetch("https://fc.yahoo.com", {
    redirect: "manual",
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  const setCookies = seed.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((entry) => entry.split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) {
    throw new Error("Yahoo Finance fc.yahoo.com did not set a cookie");
  }
  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (!crumbResponse.ok) {
    throw new Error(`Yahoo Finance crumb HTTP ${crumbResponse.status}`);
  }
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb || crumb.includes("<")) {
    throw new Error("Yahoo Finance crumb response was empty");
  }
  return { cookie, crumb };
}

async function calendarNote(sessionDate: string): Promise<string> {
  try {
    const response = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return `High-impact calendar request failed: HTTP ${response.status} from nfs.faireconomy.media.`;
    }
    const events = (await response.json()) as Array<{
      title?: string;
      country?: string;
      date?: string;
      impact?: string;
    }>;
    if (!Array.isArray(events)) {
      return "High-impact calendar returned an unexpected payload.";
    }
    const hits = events.filter((event) => {
      if (event.country !== "USD" || event.impact !== "High" || !event.date || !event.title) return false;
      return nyDate(Date.parse(event.date)) === sessionDate;
    });
    if (hits.length === 0) {
      return "No high-impact USD event is on the public calendar for this session date.";
    }
    const names = hits.map((event) => event.title).join(", ");
    return `High-impact USD events on this session: ${names}.`;
  } catch (error) {
    return `High-impact calendar could not be loaded: ${errorMessage(error)}.`;
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} for ${url.split("?")[0]}: ${body.slice(0, 160)}`);
  }
  return response.json();
}

async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function describeFeed(asOfMs: number, nowMs: number): string {
  const stamp = sessionStamp(new Date(asOfMs).toISOString());
  const ageMin = Math.max(0, Math.round((nowMs - asOfMs) / 60_000));
  if (showingPriorClose(asOfMs, nowMs)) {
    return `Yahoo Finance regular-session prices, as of ${stamp}. That is the previous regular session's close; today's chart does not have a regular-session bar yet. Not a broker feed.`;
  }
  if (marketIsClosed(asOfMs, nowMs)) {
    return `Yahoo Finance regular-session prices, as of ${stamp}. The cash session is closed, so this is the closing print rather than a fresh tick. Not a broker feed.`;
  }
  if (ageMin <= 1) {
    return `Yahoo Finance quotes, as of ${stamp}, under a minute old. Not a broker feed.`;
  }
  return `Yahoo Finance quotes, as of ${stamp}, about ${ageMin} minutes behind the clock. Not a broker feed.`;
}

function showingPriorClose(asOfMs: number, nowMs: number): boolean {
  const asOf = nyClock(asOfMs);
  const now = nyClock(nowMs);
  if (now.date <= asOf.date) return false;
  return cashSessionClockOpen(now);
}

function cashSessionClockOpen(clock: { date: string; minutes: number }): boolean {
  const day = weekday(clock.date);
  if (day === 0 || day === 6) return false;
  return clock.minutes >= 9 * 60 + 30 && clock.minutes < 16 * 60;
}

function weekday(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return 0;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function marketIsClosed(asOfMs: number, nowMs: number): boolean {
  const asOf = nyClock(asOfMs);
  const now = nyClock(nowMs);
  if (now.date > asOf.date) return true;
  if (now.date === asOf.date && now.minutes >= 16 * 60) return true;
  return false;
}

function nyDate(ms: number): string {
  return nyClock(ms).date;
}

function nyClock(ms: number): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function businessDaysBetween(fromDate: string, toDate: string): number {
  const from = utcDate(fromDate);
  const to = utcDate(toDate);
  if (!from || !to || to < from) return 0;
  let count = 0;
  const cursor = new Date(from);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= to) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function utcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function parseUsDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

function readTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface YahooChart {
  chart: {
    result?: Array<{
      meta?: ChartMeta;
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
}
