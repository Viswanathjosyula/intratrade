import { money, price } from "@/lib/format";
import type { MarketMoodName, PatternStatus, Side } from "@/lib/market/types";

/** A position Josyula already took. It is not a published target. */
export interface RecordedPosition {
  symbol: string;
  side: Side;
  shares: number;
  /** Dollars per share. */
  purchasedPrice: number;
  /** Session date, YYYY-MM-DD. */
  purchasedOn: string;
  note: string;
}

export const recordedPositions: RecordedPosition[] = [
  {
    symbol: "COST",
    side: "long",
    shares: 10,
    purchasedPrice: 1052,
    purchasedOn: "2026-11-04",
    note: "Josyula bought Costco (COST): 10 shares at $1,052 on November 4, 2026.",
  },
];

export const POSITION_RULE =
  "Sell when the stop has printed, the measured target has already printed, or the pattern that supported the position is ineligible. Hold when price is still between the stop and a target that has not printed, and the position's side still agrees with a live plan. If there is no triggered plan, hold only when the tape agrees with the side (a long holds on risk-on). Otherwise wait.";

export type PositionAction = "hold" | "sell" | "wait";

export interface PositionQuote {
  last: number;
  qualified: boolean;
  side: Side;
  status: PatternStatus;
  stop: number;
  target: number;
  patternName: string;
}

export interface DatedExtreme {
  date: string;
  high: number;
  low: number;
}

export interface PositionRow {
  symbol: string;
  side: Side;
  shares: number;
  purchasedOn: string;
  purchasedOnLabel: string;
  purchasedPriceLabel: string;
  lastLabel: string;
  profitLabel: string;
  action: PositionAction;
  actionLabel: string;
  reason: string;
}

interface PrintHit {
  printed: boolean;
  on: string | null;
}

function sessionDateLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

function profitDollars(side: Side, last: number, purchasedPrice: number, shares: number): number {
  const perShare = side === "long" ? last - purchasedPrice : purchasedPrice - last;
  return Math.round(perShare * shares * 100) / 100;
}

function profitLabel(amount: number, shares: number): string {
  const body = amount > 0 ? `+${money(amount)}` : money(amount);
  return `${body} on ${shares} ${shares === 1 ? "share" : "shares"}`;
}

function triggered(quote: PositionQuote): boolean {
  return quote.qualified && quote.status === "triggered";
}

function between(side: Side, last: number, stop: number, target: number): boolean {
  if (side === "long") return last > stop && last < target;
  return last < stop && last > target;
}

function tapeAgrees(side: Side, mood: MarketMoodName | null): boolean {
  if (mood === "risk-on" && side === "long") return true;
  if (mood === "risk-off" && side === "short") return true;
  return false;
}

function scan(side: Side, level: number, kind: "stop" | "target", bars: readonly DatedExtreme[]): PrintHit {
  const ordered = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  for (const bar of ordered) {
    const hit =
      kind === "stop"
        ? side === "long"
          ? bar.low <= level
          : bar.high >= level
        : side === "long"
          ? bar.high >= level
          : bar.low <= level;
    if (hit) return { printed: true, on: bar.date };
  }
  return { printed: false, on: null };
}

export function describePosition(
  position: RecordedPosition,
  quote: PositionQuote,
  mood: MarketMoodName | null,
  bars: readonly DatedExtreme[],
): PositionRow {
  const since = bars.filter((bar) => bar.date > position.purchasedOn);
  const lastHit = (kind: "stop" | "target", level: number): PrintHit => {
    const fromBars = scan(position.side, level, kind, since);
    const fromLast =
      kind === "stop"
        ? position.side === "long"
          ? quote.last <= level
          : quote.last >= level
        : position.side === "long"
          ? quote.last >= level
          : quote.last <= level;
    if (fromBars.printed) return fromBars;
    if (fromLast) return { printed: true, on: null };
    return { printed: false, on: null };
  };

  const stopHit = quote.qualified ? lastHit("stop", quote.stop) : { printed: false, on: null };
  const targetHit = quote.qualified ? lastHit("target", quote.target) : { printed: false, on: null };
  const patternIneligible = quote.status === "failed";
  const liveTriggered = triggered(quote);
  const sideAgrees = quote.qualified && quote.side === position.side;

  let action: PositionAction;
  let reason: string;
  if (stopHit.printed) {
    action = "sell";
    const when = stopHit.on ? ` on ${sessionDateLabel(stopHit.on)}` : "";
    reason = `Sell. The stop at ${price(quote.stop)} has printed${when}.`;
  } else if (targetHit.printed) {
    action = "sell";
    const when = targetHit.on ? ` on ${sessionDateLabel(targetHit.on)}` : "";
    reason = `Sell. The measured target ${price(quote.target)} has already printed${when}.`;
  } else if (patternIneligible) {
    action = "sell";
    reason = `Sell. The ${quote.patternName} that supported this ${position.side} is ineligible.`;
  } else if (!liveTriggered) {
    if (tapeAgrees(position.side, mood)) {
      action = "hold";
      const tape = position.side === "long" ? "risk-on" : "risk-off";
      reason = `Hold. There is no triggered plan, and the tape is ${tape}, which agrees with this ${position.side}.`;
    } else if (mood === "risk-on" || mood === "risk-off") {
      action = "wait";
      const tape = mood === "risk-on" ? "risk-on" : "risk-off";
      reason = `Wait. There is no triggered plan, and the tape is ${tape}, so this ${position.side} does not have the tape with it.`;
    } else if (mood === "mixed") {
      action = "wait";
      reason = `Wait. There is no triggered plan, and the tape is mixed, so this ${position.side} waits.`;
    } else {
      action = "wait";
      reason = `Wait. There is no triggered plan, and the tape did not come back.`;
    }
  } else if (sideAgrees && between(position.side, quote.last, quote.stop, quote.target)) {
    action = "hold";
    reason = `Hold. Price is still between the stop at ${price(quote.stop)} and the target ${price(quote.target)}, that target has not printed, and the live plan is still a ${position.side}.`;
  } else if (!sideAgrees) {
    action = "wait";
    reason = `Wait. The live plan is a ${quote.side}, so it does not agree with this ${position.side}.`;
  } else {
    action = "wait";
    reason = `Wait. Price is not between the stop and the target.`;
  }

  const profit = profitDollars(position.side, quote.last, position.purchasedPrice, position.shares);
  return {
    symbol: position.symbol,
    side: position.side,
    shares: position.shares,
    purchasedOn: position.purchasedOn,
    purchasedOnLabel: sessionDateLabel(position.purchasedOn),
    purchasedPriceLabel: money(position.purchasedPrice, Number.isInteger(position.purchasedPrice) ? 0 : 2),
    lastLabel: money(quote.last),
    profitLabel: profitLabel(profit, position.shares),
    action,
    actionLabel: action === "hold" ? "Hold" : action === "sell" ? "Sell" : "Wait",
    reason,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The gated journal table. This is not the public targets table. */
export function journalTableHtml(rows: readonly PositionRow[]): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td class="sym">${escapeHtml(row.symbol)} <span class="shares">${row.shares} shares</span></td>
        <td>${escapeHtml(row.purchasedOnLabel)}</td>
        <td>${escapeHtml(row.purchasedPriceLabel)}</td>
        <td>${escapeHtml(row.lastLabel)}</td>
        <td>${escapeHtml(row.profitLabel)}</td>
        <td data-tip="${escapeHtml(row.reason)}">${escapeHtml(row.actionLabel)}</td>
      </tr>`,
    )
    .join("\n");
  return `<div class="journal-scroll"><table>
    <thead><tr><th>Stock</th><th>Date purchased</th><th>Purchased price</th><th>Current price</th><th>Profit</th><th>Hold or sell</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="journal-note">${escapeHtml(POSITION_RULE)} Nothing here sends an order.</p>`;
}

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; Intratrade/1.0; decision-support)",
  Accept: "application/json",
};

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

function nyMinutes(ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

async function yahooBars(symbol: string, interval: string, range: string): Promise<DatedExtreme[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const response = await fetch(url, { headers: YAHOO_HEADERS });
  if (!response.ok) throw new Error(`Yahoo chart ${response.status} for ${symbol}`);
  const payload = (await response.json()) as {
    chart?: {
      error?: { description?: string };
      result?: { timestamp?: number[]; indicators?: { quote?: { high?: (number | null)[]; low?: (number | null)[] }[] } }[];
    };
  };
  if (payload.chart?.error) {
    throw new Error(payload.chart.error.description ?? `Yahoo chart error for ${symbol}`);
  }
  const result = payload.chart?.result?.[0];
  const highs = result?.indicators?.quote?.[0]?.high;
  const lows = result?.indicators?.quote?.[0]?.low;
  const stamps = result?.timestamp;
  if (!stamps || !highs || !lows) throw new Error(`Yahoo chart for ${symbol} returned no bars`);
  const bars: DatedExtreme[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const high = highs[i];
    const low = lows[i];
    if (high == null || low == null || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    const ms = stamps[i] * 1000;
    if (interval === "5m") {
      const minutes = nyMinutes(ms);
      if (minutes < 9 * 60 + 30 || minutes >= 16 * 60 || minutes % 5 !== 0) continue;
    }
    bars.push({ date: nyDate(ms), high, low });
  }
  if (bars.length === 0) throw new Error(`Yahoo chart for ${symbol} had no priced bars`);
  return bars;
}

/** Daily bars since the purchase, plus regular five-minute bars so a wick counts. */
export async function extremesSincePurchase(symbol: string): Promise<DatedExtreme[]> {
  const [daily, intraday] = await Promise.all([
    yahooBars(symbol, "1d", "6mo"),
    yahooBars(symbol, "5m", "1mo"),
  ]);
  return [...daily, ...intraday];
}
