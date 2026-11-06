import assert from "node:assert/strict";
import { buildIndicatorBoard, generalElectionDate, type ClosePoint, type CpiPoint } from "../src/lib/market/indicators";

assert.equal(generalElectionDate(2026), "2026-11-03");
assert.equal(generalElectionDate(2024), "2024-11-05");
assert.equal(generalElectionDate(2022), "2022-11-08");
assert.equal(generalElectionDate(2020), "2020-11-03");
assert.equal(generalElectionDate(2016), "2016-11-08");
assert.equal(generalElectionDate(2000), "2000-11-07");

function weekdays(start: string, until: string, closeAt: (index: number, date: string) => number): ClosePoint[] {
  const points: ClosePoint[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  while (cursor.getTime() <= end) {
    const day = cursor.getUTCDay();
    const date = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6) points.push({ date, close: closeAt(points.length, date) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

const spy = weekdays("2016-01-04", "2026-11-06", () => 100);
spy[spy.length - 1].close = 90;

const flat = (level: number) => weekdays("2026-09-01", "2026-11-06", (index, date) => {
  void date;
  return level;
});
const yield10 = weekdays("2026-09-01", "2026-11-06", () => 4);
yield10[yield10.length - 1].close = 4.5;
const tip = flat(100);
tip[tip.length - 1].close = 99;
const ief = flat(100);
ief[ief.length - 1].close = 101;
const dollar = flat(100);
dollar[dollar.length - 1].close = 98;
const oil = flat(100);
oil[oil.length - 1].close = 105;

const cpi: CpiPoint[] = [
  { year: 2024, month: 9, value: 100 },
  { year: 2025, month: 9, value: 103 },
  { year: 2026, month: 9, value: 105 },
];

const board = buildIndicatorBoard({ spy, yield10, tip, ief, dollar, oil, cpi });
assert.equal(board.tape?.side, "down");
assert.equal(board.tape?.relation, "below");
assert.equal(board.omitted.length, 0);

const byFactor = (factor: string, period?: string) =>
  board.rows.find((row) => row.factor === factor && (period == null || row.period === period));

const month = byFactor("S&P 500", "21 sessions");
assert.ok(month);
assert.equal(month.alignment, "with");
assert.match(month.statistic, /^−10\.0% · avg /);
assert.match(month.statistic, /since 2016/);

const year = byFactor("S&P 500", "252 sessions");
assert.equal(year?.alignment, "with");
assert.equal(year?.statistic, "−10.0%");

const election = byFactor("S&P after elections");
assert.ok(election);
assert.equal(election.alignment, "with");
assert.match(election.period, /2026/);
assert.match(election.statistic, /−10\.0% over \d+ sessions · avg 0\.0% after 5 elections/);

const yieldRow = byFactor("10-year yield");
assert.equal(yieldRow?.alignment, "with");
assert.match(yieldRow?.statistic ?? "", /4\.50% from 4\.00% \(\+0\.50 pt\)/);

const cpiRow = byFactor("CPI");
assert.equal(cpiRow?.period, "12 months to Sep 2026");
assert.equal(cpiRow?.alignment, "against");
assert.match(cpiRow?.statistic ?? "", /\+1\.9% year over year · prior year \+3\.0%/);

const tips = byFactor("TIPS vs Treasuries");
assert.equal(tips?.alignment, "against");
assert.match(tips?.statistic ?? "", /spread −2\.0 pt/);

assert.equal(byFactor("Dollar")?.alignment, "against");
assert.equal(byFactor("Oil")?.alignment, "with");
assert.equal(byFactor("Oil")?.statistic, "+5.0%");

const missingOil = buildIndicatorBoard({ spy, yield10, tip, ief, dollar, oil: null, cpi });
assert.equal(missingOil.rows.some((row) => row.factor === "Oil"), false);
assert.deepEqual(missingOil.omitted, ["Oil (CL=F)"]);

const monthly: ClosePoint[] = Array.from({ length: 40 }, (_, index) => {
  const cursor = new Date(Date.UTC(2020, index, 1));
  return { date: cursor.toISOString().slice(0, 10), close: 100 + index };
});
const noTape = buildIndicatorBoard({
  spy: monthly,
  yield10: null,
  tip: null,
  ief: null,
  dollar: null,
  oil: null,
  cpi: null,
});
assert.equal(noTape.rows.length, 0);
assert.equal(noTape.tape, null);
assert.deepEqual(noTape.omitted, ["S&P 500 (SPY)"]);

const up = weekdays("2016-01-04", "2026-11-06", (index) => 100 + index);
const rising = buildIndicatorBoard({ spy: up, yield10: null, tip: null, ief: null, dollar: null, oil: null, cpi: null });
assert.equal(rising.tape?.side, "up");
assert.equal(rising.rows.find((row) => row.period === "252 sessions")?.alignment, "with");
assert.ok(rising.omitted.includes("10-year yield (^TNX)"));
assert.ok(rising.omitted.includes("CPI (BLS CUUR0000SA0)"));
assert.ok(rising.omitted.includes("Dollar (UUP)"));
