import type { OpeningRangeEvent, PatternPillar, VwapEvent } from "./types";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tape {
  last: number;
  vwap: number;
  vwapEvent: VwapEvent;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeEvent: OpeningRangeEvent;
  intradayAtr: number;
  dailyAtr: number;
  relativeVolume: number;
}

interface Candidate {
  score: number;
  measuredTarget: number;
  atrTimeframe: "5-minute" | "daily";
  pattern: PatternPillar;
}

export function averageTrueRange(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const ranges: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const previous = bars[i - 1].close;
    ranges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - previous),
        Math.abs(bars[i].low - previous),
      ),
    );
  }
  const window = ranges.slice(-period);
  if (window.length === 0) return 0;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

export function analyzeTape(daily: Bar[], session: Bar[]): Tape | null {
  if (daily.length < 2 || session.length < 3) return null;
  const last = session[session.length - 1].close;
  let priceVolume = 0;
  let volume = 0;
  let sawBelow = false;
  let sawAbove = false;
  let reclaimed = false;
  let rejected = false;

  for (const bar of session) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const barVolume = bar.volume > 0 ? bar.volume : 1;
    priceVolume += typical * barVolume;
    volume += barVolume;
    const running = priceVolume / volume;
    if (bar.low < running) sawBelow = true;
    if (bar.high > running) sawAbove = true;
    if (sawBelow && bar.close > running) reclaimed = true;
    if (sawAbove && bar.close < running) rejected = true;
  }

  const vwap = priceVolume / volume;
  const gap = vwap === 0 ? 0 : Math.abs(last - vwap) / vwap;
  let vwapEvent: VwapEvent = "chop";
  if (gap >= 0.0015) {
    if (last > vwap && reclaimed && sawBelow) vwapEvent = "reclaim";
    else if (last > vwap) vwapEvent = "holding-above";
    else if (last < vwap && rejected && sawAbove) vwapEvent = "reject";
    else vwapEvent = "holding-below";
  }

  const opening = session.slice(0, Math.min(6, session.length));
  const openingRangeHigh = Math.max(...opening.map((bar) => bar.high));
  const openingRangeLow = Math.min(...opening.map((bar) => bar.low));
  let openingRangeEvent: OpeningRangeEvent = "inside";
  if (last > openingRangeHigh) openingRangeEvent = "break-up";
  else if (last < openingRangeLow) openingRangeEvent = "break-down";

  const priorVolumes = daily.slice(0, -1).slice(-20).map((bar) => bar.volume).filter((value) => value > 0);
  const averageVolume =
    priorVolumes.length > 0
      ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
      : 0;
  const todayVolume = daily[daily.length - 1].volume;
  const relativeVolume = averageVolume > 0 ? todayVolume / averageVolume : 1;

  return {
    last,
    vwap,
    vwapEvent,
    openingRangeHigh,
    openingRangeLow,
    openingRangeEvent,
    intradayAtr: averageTrueRange(session, 14),
    dailyAtr: averageTrueRange(daily, 14),
    relativeVolume,
  };
}

export function choosePattern(daily: Bar[], tape: Tape): {
  pattern: PatternPillar;
  measuredTarget: number;
  atr: number;
  atrTimeframe: "5-minute" | "daily";
} {
  const tapeBullish = tape.vwapEvent === "reclaim" || tape.vwapEvent === "holding-above";
  const tapeBearish = tape.vwapEvent === "reject" || tape.vwapEvent === "holding-below";
  const candidates = [
    bullFlag(daily),
    bearFlag(daily),
    doubleBottom(daily),
    doubleTop(daily),
    inverseHeadAndShoulders(daily),
    headAndShoulders(daily),
    cupAndHandle(daily),
    rangeBreak(daily, "Breakout"),
    rangeBreak(daily, "Breakdown"),
    openingRangeBreak(tape),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  for (const candidate of candidates) {
    if (tapeBullish && candidate.pattern.bias === "bullish") candidate.score += 12;
    if (tapeBearish && candidate.pattern.bias === "bearish") candidate.score += 12;
    if (tapeBullish && candidate.pattern.bias === "bearish") candidate.score -= 8;
    if (tapeBearish && candidate.pattern.bias === "bullish") candidate.score -= 8;
    if (candidate.pattern.status === "triggered") candidate.score += 8;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    const bullish = tape.last >= tape.vwap;
    return {
      pattern: {
        name: "Breakout",
        bias: bullish ? "bullish" : "bearish",
        status: "forming",
        invalidation: round(tape.last),
        note: "No bull flag, bear flag, double top, double bottom, head and shoulders, cup and handle, breakout, breakdown, or opening-range break is on this tape.",
      },
      measuredTarget: round(tape.last),
      atr: saneAtr(tape.dailyAtr, tape.last),
      atrTimeframe: "daily",
    };
  }

  const atr = best.atrTimeframe === "5-minute" ? tape.intradayAtr : tape.dailyAtr;
  return {
    pattern: {
      ...best.pattern,
      invalidation: round(best.pattern.invalidation),
    },
    measuredTarget: round(best.measuredTarget),
    atr: saneAtr(atr, tape.last),
    atrTimeframe: best.atrTimeframe,
  };
}

function saneAtr(value: number, last: number): number {
  const floor = Math.max(last * 0.0015, 0.05);
  if (!Number.isFinite(value) || value < floor) return round(floor);
  return round(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function swings(bars: Bar[], span = 2): { index: number; kind: "high" | "low"; price: number }[] {
  const points: { index: number; kind: "high" | "low"; price: number }[] = [];
  for (let i = span; i < bars.length - span; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) points.push({ index: i, kind: "high", price: bars[i].high });
    else if (isLow) points.push({ index: i, kind: "low", price: bars[i].low });
  }
  return points;
}

function money(value: number): string {
  return value.toFixed(2);
}

function bullFlag(daily: Bar[]): Candidate | null {
  return flag(daily, "bull");
}

function bearFlag(daily: Bar[]): Candidate | null {
  return flag(daily, "bear");
}

function flag(daily: Bar[], direction: "bull" | "bear"): Candidate | null {
  const count = daily.length;
  if (count < 20) return null;
  let best: Candidate | null = null;

  for (let flagLength = 3; flagLength <= 8; flagLength += 1) {
    const flagStart = count - 1 - flagLength;
    if (flagStart < 8) continue;
    const flagBars = daily.slice(flagStart, count - 1);
    const poleEnd = flagStart - 1;
    for (let poleLength = 3; poleLength <= 8; poleLength += 1) {
      const poleStart = poleEnd - poleLength + 1;
      if (poleStart < 0) continue;
      const pole = daily.slice(poleStart, poleEnd + 1);
      const poleLow = Math.min(...pole.map((bar) => bar.low));
      const poleHigh = Math.max(...pole.map((bar) => bar.high));
      const poleHeight = poleHigh - poleLow;
      if (poleLow <= 0 || poleHeight / poleLow < 0.05) continue;
      if (direction === "bull" && pole[pole.length - 1].close < poleLow + poleHeight * 0.6) continue;
      if (direction === "bear" && pole[pole.length - 1].close > poleHigh - poleHeight * 0.6) continue;

      const flagHigh = Math.max(...flagBars.map((bar) => bar.high));
      const flagLow = Math.min(...flagBars.map((bar) => bar.low));
      const retrace =
        direction === "bull" ? (poleHigh - flagLow) / poleHeight : (flagHigh - poleLow) / poleHeight;
      if (retrace > 0.5 || retrace < 0) continue;
      if (flagHigh - flagLow > poleHeight * 0.6) continue;

      const last = daily[count - 1];
      const triggered =
        direction === "bull"
          ? last.close > flagHigh && last.close >= last.open
          : last.close < flagLow && last.close <= last.open;
      const forming =
        !triggered &&
        (direction === "bull"
          ? last.close <= flagHigh && last.close >= flagLow
          : last.close >= flagLow && last.close <= flagHigh);
      if (!triggered && !forming) continue;

      const anchor = direction === "bull" ? (triggered ? last.close : flagHigh) : triggered ? last.close : flagLow;
      const measuredTarget = direction === "bull" ? anchor + poleHeight : anchor - poleHeight;
      const score = (triggered ? 72 : 42) + Math.min(18, (poleHeight / poleLow) * 80);
      const name = direction === "bull" ? "Bull flag" : "Bear flag";
      const candidate: Candidate = {
        score,
        measuredTarget,
        atrTimeframe: "daily",
        pattern: {
          name,
          bias: direction === "bull" ? "bullish" : "bearish",
          status: triggered ? "triggered" : "forming",
          invalidation: direction === "bull" ? flagLow : flagHigh,
          note: triggered
            ? `${name} cleared ${money(direction === "bull" ? flagHigh : flagLow)} after a ${((poleHeight / poleLow) * 100).toFixed(1)}% pole. The flag fails through ${money(direction === "bull" ? flagLow : flagHigh)}.`
            : `${name} is still inside ${money(flagLow)}–${money(flagHigh)} after a ${((poleHeight / poleLow) * 100).toFixed(1)}% pole.`,
        },
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

function rangeBreak(daily: Bar[], name: "Breakout" | "Breakdown"): Candidate | null {
  if (daily.length < 22) return null;
  const last = daily[daily.length - 1];
  const prior = daily.slice(-21, -1);
  const priorHigh = Math.max(...prior.map((bar) => bar.high));
  const priorLow = Math.min(...prior.map((bar) => bar.low));
  const range = priorHigh - priorLow;
  if (range <= 0) return null;

  if (name === "Breakout" && last.close > priorHigh) {
    return {
      score: 66,
      measuredTarget: last.close + range * 0.5,
      atrTimeframe: "daily",
      pattern: {
        name: "Breakout",
        bias: "bullish",
        status: "triggered",
        invalidation: priorHigh,
        note: `Closed through the prior 20-session high at ${money(priorHigh)}.`,
      },
    };
  }
  if (name === "Breakdown" && last.close < priorLow) {
    return {
      score: 66,
      measuredTarget: last.close - range * 0.5,
      atrTimeframe: "daily",
      pattern: {
        name: "Breakdown",
        bias: "bearish",
        status: "triggered",
        invalidation: priorLow,
        note: `Closed through the prior 20-session low at ${money(priorLow)}.`,
      },
    };
  }
  return null;
}

function doubleBottom(daily: Bar[]): Candidate | null {
  return double(daily, "bottom");
}

function doubleTop(daily: Bar[]): Candidate | null {
  return double(daily, "top");
}

function double(daily: Bar[], kind: "top" | "bottom"): Candidate | null {
  const points = swings(daily).filter((point) => point.kind === (kind === "top" ? "high" : "low"));
  if (points.length < 2 || daily.length < 20) return null;
  const last = daily[daily.length - 1];
  let best: Candidate | null = null;

  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const first = points[i];
      const second = points[j];
      if (second.index - first.index < 8) continue;
      if (Math.abs(first.price - second.price) / first.price > 0.02) continue;
      const between = daily.slice(first.index, second.index + 1);
      const neck =
        kind === "top"
          ? Math.min(...between.map((bar) => bar.low))
          : Math.max(...between.map((bar) => bar.high));
      const extreme = (first.price + second.price) / 2;
      const separation = Math.abs(extreme - neck) / extreme;
      if (separation < 0.03) continue;
      const triggered = kind === "top" ? last.close < neck : last.close > neck;
      const forming =
        !triggered &&
        (kind === "top"
          ? last.close < extreme && last.close >= neck
          : last.close > extreme && last.close <= neck);
      if (!triggered && !forming) continue;
      if (daily.length - 1 - second.index > 15) continue;
      const height = Math.abs(extreme - neck);
      const measuredTarget = kind === "top" ? neck - height : neck + height;
      const score = (triggered ? 74 : 44) + Math.min(12, separation * 100);
      const candidate: Candidate = {
        score,
        measuredTarget,
        atrTimeframe: "daily",
        pattern: {
          name: kind === "top" ? "Double top" : "Double bottom",
          bias: kind === "top" ? "bearish" : "bullish",
          status: triggered ? "triggered" : "forming",
          invalidation: kind === "top" ? extreme : extreme,
          note:
            kind === "top"
              ? `Two highs near ${money(extreme)} share a neckline at ${money(neck)}. ${triggered ? `Price closed through that neckline.` : `Price has not closed through ${money(neck)}.`}`
              : `Two lows near ${money(extreme)} share a neckline at ${money(neck)}. ${triggered ? `Price closed through that neckline.` : `Price has not closed through ${money(neck)}.`}`,
        },
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

function headAndShoulders(daily: Bar[]): Candidate | null {
  return shoulders(daily, "head");
}

function inverseHeadAndShoulders(daily: Bar[]): Candidate | null {
  return shoulders(daily, "inverse");
}

function shoulders(daily: Bar[], kind: "head" | "inverse"): Candidate | null {
  const points = swings(daily).filter((point) => point.kind === (kind === "head" ? "high" : "low"));
  if (points.length < 3) return null;
  const last = daily[daily.length - 1];
  let best: Candidate | null = null;

  for (let i = 0; i < points.length - 2; i += 1) {
    const left = points[i];
    const head = points[i + 1];
    const right = points[i + 2];
    if (right.index - left.index < 12) continue;
    if (daily.length - 1 - right.index > 12) continue;
    const headDominant =
      kind === "head"
        ? head.price > left.price * 1.015 && head.price > right.price * 1.015
        : head.price < left.price * 0.985 && head.price < right.price * 0.985;
    if (!headDominant) continue;
    if (Math.abs(left.price - right.price) / Math.abs(head.price) > 0.035) continue;
    const between = daily.slice(left.index, right.index + 1);
    const neck =
      kind === "head"
        ? Math.min(...between.map((bar) => bar.low))
        : Math.max(...between.map((bar) => bar.high));
    const triggered = kind === "head" ? last.close < neck : last.close > neck;
    const forming = !triggered && (kind === "head" ? last.close < head.price : last.close > head.price);
    if (!triggered && !forming) continue;
    const height = Math.abs(((left.price + right.price) / 2) - neck);
    if (height <= 0) continue;
    const score = triggered ? 76 : 40;
    const candidate: Candidate = {
      score,
      measuredTarget: kind === "head" ? neck - height : neck + height,
      atrTimeframe: "daily",
      pattern: {
        name: kind === "head" ? "Head and shoulders" : "Inverse head and shoulders",
        bias: kind === "head" ? "bearish" : "bullish",
        status: triggered ? "triggered" : "forming",
        invalidation: kind === "head" ? head.price : head.price,
        note: `${kind === "head" ? "Head and shoulders" : "Inverse head and shoulders"} has a neckline at ${money(neck)}. ${triggered ? "The close is through that neckline." : "The neckline is still intact."}`,
      },
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function cupAndHandle(daily: Bar[]): Candidate | null {
  if (daily.length < 40) return null;
  const window = daily.slice(-50);
  const last = window[window.length - 1];
  const left = window.slice(0, 12);
  const rim = Math.max(...left.map((bar) => bar.high));
  const middle = window.slice(8, window.length - 8);
  if (middle.length < 10 || rim <= 0) return null;
  const cupLow = Math.min(...middle.map((bar) => bar.low));
  const depth = (rim - cupLow) / rim;
  if (depth < 0.08 || depth > 0.4) return null;
  const right = window.slice(window.length - 14, window.length - 5);
  if (right.length < 4) return null;
  const rightHigh = Math.max(...right.map((bar) => bar.high));
  if (rightHigh < rim * 0.97) return null;
  const handle = window.slice(window.length - 6, window.length - 1);
  const handleLow = Math.min(...handle.map((bar) => bar.low));
  if ((rightHigh - handleLow) / (rim - cupLow) > 0.45) return null;
  const triggered = last.close > rightHigh && last.close >= last.open;
  return {
    score: triggered ? 73 : 41,
    measuredTarget: (triggered ? last.close : rightHigh) + (rim - cupLow) * 0.5,
    atrTimeframe: "daily",
    pattern: {
      name: "Cup and handle",
      bias: "bullish",
      status: triggered ? "triggered" : "forming",
      invalidation: handleLow,
      note: triggered
        ? `Cup and handle cleared ${money(rightHigh)}. The handle low is ${money(handleLow)}.`
        : `Cup is rebuilt near ${money(rightHigh)}, and the handle from ${money(handleLow)} has not broken out.`,
    },
  };
}

function openingRangeBreak(tape: Tape): Candidate | null {
  const width = tape.openingRangeHigh - tape.openingRangeLow;
  if (!(width > 0)) return null;
  if (tape.openingRangeEvent === "inside") return null;
  const bullish = tape.openingRangeEvent === "break-up";
  const extension = bullish ? tape.last - tape.openingRangeHigh : tape.openingRangeLow - tape.last;
  if (tape.intradayAtr > 0 && extension < tape.intradayAtr * 0.2) return null;
  const participation = tape.relativeVolume >= 1.2 ? 8 : 0;
  const breakLevel = bullish ? tape.openingRangeHigh : tape.openingRangeLow;
  return {
    score: 52 + participation,
    measuredTarget: bullish ? breakLevel + width : breakLevel - width,
    atrTimeframe: "daily",
    pattern: {
      name: "Opening-range break",
      bias: bullish ? "bullish" : "bearish",
      status: "triggered",
      invalidation: bullish ? tape.openingRangeHigh : tape.openingRangeLow,
      note: `The first 30 minutes ran ${money(tape.openingRangeLow)}–${money(tape.openingRangeHigh)}, and the session closed outside that range.`,
    },
  };
}
