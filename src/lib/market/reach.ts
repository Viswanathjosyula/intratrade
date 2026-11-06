/**
 * Sessions from the last price to the pattern target, at one daily ATR per session.
 * The date is that many trading sessions after the as-of session, skipping weekends.
 */
export interface ReachEstimate {
  sessions: number;
  /** YYYY-MM-DD in the New York session calendar. */
  date: string;
}

export function estimatedReach(input: {
  asOf: string;
  last: number;
  target: number;
  atr: number;
  atrTimeframe?: "5-minute" | "daily";
}): ReachEstimate | null {
  if (input.atrTimeframe !== "daily") return null;
  if (!Number.isFinite(input.atr) || input.atr <= 0) return null;
  if (!Number.isFinite(input.last) || !Number.isFinite(input.target)) return null;

  const sessionDate = newYorkSessionDate(input.asOf);
  if (!sessionDate) return null;

  const distance = Math.abs(input.target - input.last);
  const sessions = Math.ceil(distance / input.atr);
  const date = addTradingSessions(sessionDate, sessions);
  if (!date) return null;
  return { sessions, date };
}

export function reachLabel(estimate: ReachEstimate | null): string {
  if (!estimate) return "Estimated reach date unavailable.";
  const count = estimate.sessions === 1 ? "1 session" : `${estimate.sessions} sessions`;
  return `${formatSessionDate(estimate.date)}, if price travels about one daily ATR per session toward the target (${count}).`;
}

export function newYorkSessionDate(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(parsed)
      .map((part) => [part.type, part.value]),
  );
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addTradingSessions(fromDate: string, sessions: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromDate);
  if (!match || !Number.isInteger(sessions) || sessions < 0) return null;
  const cursor = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  let remaining = sessions;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  const year = cursor.getUTCFullYear();
  const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
  const day = String(cursor.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatSessionDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}
