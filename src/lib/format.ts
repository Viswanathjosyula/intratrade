import type { OpeningRangeEvent, Sentiment, Side, Stance, VwapEvent } from "@/lib/market/types";

export function money(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function price(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function revenue(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  return money(value);
}

export function earningsRead(input: {
  earningsSurprisePct: number;
  earningsSurpriseBasis: "revenue" | "eps";
  earnings: {
    revenueActual: number;
    revenueEstimate: number | null;
    epsActual?: number | null;
    epsEstimate?: number | null;
  };
}): { title: string; dollars: string } {
  const { earnings } = input;
  const dollars =
    earnings.revenueActual > 0
      ? `${revenue(earnings.revenueActual)} reported revenue`
      : "Reported revenue was not in the feed";
  if (
    input.earningsSurpriseBasis === "eps" &&
    typeof earnings.epsActual === "number" &&
    typeof earnings.epsEstimate === "number"
  ) {
    return {
      title: `EPS ${earnings.epsActual.toFixed(2)} vs ${earnings.epsEstimate.toFixed(2)} (${signedPct(input.earningsSurprisePct)})`,
      dollars,
    };
  }
  if (typeof earnings.revenueEstimate === "number") {
    return {
      title: `${signedPct(input.earningsSurprisePct)} revenue vs ${revenue(earnings.revenueEstimate)} estimate`,
      dollars: `${revenue(earnings.revenueActual)} actual vs ${revenue(earnings.revenueEstimate)} estimate`,
    };
  }
  return { title: "No revenue or EPS consensus in the feed", dollars };
}

export function signedPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function rewardRisk(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}:1`;
}

export function shareCount(value: number): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? "share" : "shares"}`;
}

export function sessionStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function dayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function sideLabel(side: Side): string {
  return side === "long" ? "Long" : "Short";
}

export function stanceLabel(stance: Stance): string {
  return stance === "consider" ? "Consider" : "Stand aside";
}

export function sentimentLabel(sentiment: Sentiment): string {
  switch (sentiment) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    case "mixed":
      return "Mixed";
    case "neutral":
      return "Neutral";
  }
}

export function vwapLabel(event: VwapEvent): string {
  switch (event) {
    case "reclaim":
      return "Reclaim";
    case "reject":
      return "Reject";
    case "holding-above":
      return "Holding above";
    case "holding-below":
      return "Holding below";
    case "chop":
      return "Chop";
  }
}

export function openingRangeLabel(event: OpeningRangeEvent): string {
  switch (event) {
    case "break-up":
      return "Break up";
    case "break-down":
      return "Break down";
    case "inside":
      return "Inside";
  }
}

export function ageLabel(age: "fresh" | "recent" | "stale"): string {
  if (age === "fresh") return "Fresh print";
  if (age === "recent") return "Recent print";
  return "Stale print";
}
