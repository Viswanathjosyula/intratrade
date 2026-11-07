import { renameSync, writeFileSync } from "node:fs";

import { addedPrice, earningsRead, price, rewardRisk, sentimentLabel, sideLabel, stanceLabel } from "@/lib/format";
import { trackBook, type TrackedBook } from "@/lib/market/call-log";
import { callConfidence, confidenceLabel, confidentCalls, groupCalls, settledHitLabel, shareOfSuggestionsLabel, suggestionRates, type CallStatus } from "@/lib/market/calls";
import { rankIdeas } from "@/lib/market/engine";
import { loadPublicSession } from "@/lib/market/live";
import { moodLabel, timingCall } from "@/lib/market/mood";
import { estimatedReach, formatSessionDate, reachLabel } from "@/lib/market/reach";
import { DEFAULT_RISK, type IndicatorBoard, type MarketMood, type TradeIdea } from "@/lib/market/types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusText(status: CallStatus): string {
  if (status === "reached") return "Reached";
  if (status === "not-reached") return "Not reached";
  return "Open";
}

const CONFIDENCE_LINE =
  "Confidence is 100% when the target has been reached. Otherwise it is the average of four equal readings from this book: risk/(risk+reward) for tagging the target before the stop, 1/(1+daily ATRs still left), 100 if the pace date is still ahead and 0 if it has been missed, and 100, 50, or 0 when the side agrees with the mood, the mood is mixed, or the side fights it. A row is listed only when that percent is above 50.";

function renderCallRow(
  call: TrackedBook["calls"][number],
  through: string | null,
  mood: MarketMood | null,
): string {
  const confidence = confidenceLabel(
    callConfidence({
      status: call.status,
      side: call.side,
      target: call.target,
      stop: call.stop,
      entry: call.entry,
      paceDate: call.paceDate,
      nextPaceDate: call.nextPaceDate,
      latestClose: call.latestClose,
      dailyAtr: call.dailyAtr,
      through,
      mood: mood?.name ?? null,
    }),
  );
  return `<tr class="side-${call.side}">
          <td class="sym ${call.side}">${escapeHtml(call.symbol)}</td>
          <td class="${call.side}">${escapeHtml(sideLabel(call.side))}</td>
          <td>${escapeHtml(addedPrice(call.entry))}</td>
          <td>${price(call.target)}</td>
          <td class="conf">${escapeHtml(confidence)}</td>
          <td>${escapeHtml(formatSessionDate(call.asOf))}</td>
          <td>${call.paceDate ? escapeHtml(formatSessionDate(call.paceDate)) : ""}</td>
          <td>${call.nextPaceDate ? escapeHtml(formatSessionDate(call.nextPaceDate)) : ""}</td>
          <td class="${call.status}">${statusText(call.status)}</td>
        </tr>`;
}

function renderTargets(tracked: TrackedBook, mood: MarketMood | null): string {
  const shown = confidentCalls(tracked.calls, tracked.through, mood?.name ?? null);
  const rates = suggestionRates(shown);
  const rows =
    shown.length === 0
      ? `<tr><td colspan="9">No published consider call is above 50% confidence.</td></tr>`
      : groupCalls(shown)
          .map((group) => {
            const body =
              group.calls.length === 0
                ? `<tr class="empty"><td colspan="9">None</td></tr>`
                : group.calls.map((call) => renderCallRow(call, tracked.through, mood)).join("\n");
            return `<tr class="group ${group.status}"><td colspan="9">${escapeHtml(statusText(group.status))} · ${group.calls.length}</td></tr>
${body}`;
          })
          .join("\n");
  const checked = tracked.through
    ? `Checked against Yahoo regular-session bars through ${formatSessionDate(tracked.through)}.`
    : "Yahoo bars were not available, so every row stays open.";
  const gap = tracked.incomplete ? " Names with no confirming bars stay open." : "";
  return `<section class="targets" aria-label="Target tracking">
    <div class="targets-head">
      <h2>Targets</h2>
      <div class="rates">
        <p><span class="reached">${rates.reached} reached</span> · <span class="not-reached">${rates.notReached} not reached</span> · <span class="open">${rates.open} open</span></p>
        <p>${escapeHtml(settledHitLabel(rates))}</p>
        <p>${escapeHtml(shareOfSuggestionsLabel(rates))}</p>
      </div>
    </div>
    <div class="targets-scroll">
      <table>
        <thead><tr><th>Name</th><th>Side</th><th>Added at</th><th>Target</th><th>Confidence</th><th>As of</th><th>Pace</th><th>New pace</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="targets-note">${escapeHtml(`${checked}${gap}`)} Added at is the price stored when the call was published. ${escapeHtml(CONFIDENCE_LINE)} This table does not send an order.</p>
  </section>`;
}

function renderIndicators(board: IndicatorBoard | null): string {
  if (!board) return "";
  const tape = board.tape
    ? `S&P ${price(board.tape.last)} is ${board.tape.relation} its 10-session average of ${price(board.tape.average)}.`
    : "S&P versus its 10-session average did not come back.";
  const body =
    board.rows.length === 0
      ? ""
      : `<div class="indicators-scroll"><table>
        <thead><tr><th>Factor</th><th>Period</th><th>Statistic</th><th>Tape</th></tr></thead>
        <tbody>${board.rows
          .map(
            (row) => `<tr>
          <td>${escapeHtml(row.factor)}</td>
          <td>${escapeHtml(row.period)}</td>
          <td class="stat">${escapeHtml(row.statistic)}</td>
          <td class="${row.alignment}">${row.alignment === "with" ? "With" : "Against"}</td>
        </tr>`,
          )
          .join("")}</tbody>
      </table></div>`;
  const omitted =
    board.omitted.length > 0
      ? `<p class="indicators-note">Omitted: ${escapeHtml(board.omitted.join("; "))}.</p>`
      : "";
  return `<section class="indicators" aria-label="Tape indicators">
    <div class="indicators-head"><h2>Indicators</h2><p>${escapeHtml(tape)}</p></div>
    ${body}${omitted}
  </section>`;
}

function renderMood(mood: MarketMood | null): string {
  if (!mood) {
    return `<section class="mood" aria-label="Market mood"><p class="mood-name">Mood unavailable</p><p>Yahoo did not return SPY, book breadth, or VIX.</p></section>`;
  }
  return `<section class="mood ${mood.name}" aria-label="Market mood"><p class="mood-name">${escapeHtml(moodLabel(mood.name))}</p><p>${escapeHtml(mood.summary)}</p></section>`;
}

function render(
  ideas: TradeIdea[],
  meta: string,
  asOf: string,
  tracked: TrackedBook,
  mood: MarketMood | null,
  indicators: IndicatorBoard | null,
): string {
  const consider = ideas.filter((idea) => idea.stance === "consider").length;
  const aside = ideas.length - consider;
  const selected = ideas.find((idea) => idea.stance === "consider") ?? ideas[0];
  const rules = ideas
    .map((idea) => {
      const color = idea.stance === "consider" ? "#6ee7b7" : "#fde68a";
      return `#pick-${idea.symbol}:checked ~ .board .plan-${idea.symbol},
#pick-${idea.symbol}:checked ~ .board .keys-${idea.symbol} { display: flex; }
#pick-${idea.symbol}:checked ~ .board label[for="pick-${idea.symbol}"] { outline: 2px solid ${color}; }`;
    })
    .join("\n");

  const radios = ideas
    .map(
      (idea) =>
        `<input class="pick" type="radio" name="book" id="pick-${idea.symbol}"${idea.symbol === selected?.symbol ? " checked" : ""}>`,
    )
    .join("\n");

  const keys = ideas
    .map((idea) => {
      const reach = estimatedReach({
        asOf,
        last: idea.last,
        target: idea.target,
        atr: idea.atr,
        atrTimeframe: idea.atrTimeframe,
      });
      const sessions = reach ? (reach.sessions === 1 ? "1 session" : `${reach.sessions} sessions`) : "Reach date unavailable";
      return `<article class="keys keys-${idea.symbol}">
        <div class="keys-top"><strong class="${idea.side}">${escapeHtml(idea.symbol)}</strong><span><span class="${idea.side}">${escapeHtml(sideLabel(idea.side))}</span> · ${escapeHtml(stanceLabel(idea.stance))}</span></div>
        <dl>
          <div><dt>Last</dt><dd>${price(idea.last)}</dd></div>
          <div><dt>Target</dt><dd>${price(idea.target)}</dd></div>
          <div><dt>Stop</dt><dd>${price(idea.stop)}</dd></div>
          <div><dt>R:R</dt><dd>${rewardRisk(idea.riskReward)}</dd></div>
        </dl>
        <p>${escapeHtml(sessions)}</p>
      </article>`;
    })
    .join("\n");

  const boxes = ideas
    .map(
      (idea) =>
        `<label class="box ${idea.stance === "consider" ? "consider" : "aside"}" for="pick-${idea.symbol}"><span class="sym ${idea.side}">${escapeHtml(idea.symbol)}</span><span class="sub"><span class="${idea.side}">${escapeHtml(sideLabel(idea.side))}</span> · ${price(idea.last)}</span></label>`,
    )
    .join("\n");

  const plans = ideas
    .map((idea) => {
      const earnings = earningsRead(idea);
      const reach = reachLabel(
        estimatedReach({
          asOf,
          last: idea.last,
          target: idea.target,
          atr: idea.atr,
          atrTimeframe: idea.atrTimeframe,
        }),
      );
      const tone = idea.stance === "consider" ? "consider" : "aside";
      const timing = mood && idea.stance === "consider" ? timingCall(mood.name, idea.side) : null;
      return `<article class="plan plan-${idea.symbol}">
        <header class="plan-head">
          <div><h2 class="${idea.side}">${escapeHtml(idea.symbol)}</h2><p class="name">${escapeHtml(idea.name)}</p></div>
          <p class="plan-side"><span class="${idea.side}">${escapeHtml(sideLabel(idea.side))}</span> <span class="badge ${tone}">${escapeHtml(stanceLabel(idea.stance))}</span></p>
        </header>
        <dl class="stats">
          <div><dt>Last</dt><dd>${price(idea.last)}</dd></div>
          <div><dt>Target</dt><dd>${price(idea.target)}</dd></div>
          <div><dt>Stop</dt><dd>${price(idea.stop)}</dd></div>
          <div><dt>Reward:risk</dt><dd>${rewardRisk(idea.riskReward)}</dd></div>
        </dl>
        <p class="reach">${escapeHtml(reach)}</p>
        ${timing ? `<p class="timing ${timing.action}">${escapeHtml(timing.line)}</p>` : ""}
        <p><strong>News.</strong> ${escapeHtml(sentimentLabel(idea.news.sentiment))}. ${escapeHtml(idea.news.headline)}</p>
        <p><strong>Earnings.</strong> ${escapeHtml(earnings.title)}. ${escapeHtml(earnings.dollars)}. ${escapeHtml(idea.earnings.period)}.</p>
        <p><strong>Pattern.</strong> ${escapeHtml(idea.pattern.name)}, ${escapeHtml(idea.pattern.status)}. ${escapeHtml(idea.pattern.note)}</p>
        <p class="reason">${escapeHtml(idea.reasons[0] ?? "")}</p>
      </article>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intratrade</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #12162a; color: #f4f6ff; font-size: 15px; }
    header.site, footer { padding: 0.6rem 1rem; border-bottom: 2px solid rgba(129, 140, 248, 0.45); }
    footer { border-bottom: 0; border-top: 2px solid rgba(129, 140, 248, 0.45); color: #c7d2fe; font-size: 0.75rem; text-align: center; }
    header.site { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
    header.site h1 { margin: 0; font-size: 1.15rem; font-weight: 750; letter-spacing: -0.02em; }
    .meta { margin: 0.3rem 0 0; color: #c7d2fe; font-size: 0.78rem; line-height: 1.4; }
    .counts { color: #e0e7ff; font-size: 0.85rem; font-weight: 700; white-space: nowrap; }
    .consider-count { color: #34d399; }
    .aside-count { color: #fbbf24; }
    .pick { position: absolute; opacity: 0; pointer-events: none; }
    .board { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(17rem, 0.8fr); gap: 0.75rem; padding: 0.75rem 1rem 1rem; align-items: start; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.35rem; }
    .box { display: flex; flex-direction: column; justify-content: center; border-radius: 0.45rem; padding: 0.45rem 0.5rem; cursor: pointer; min-height: 2.85rem; border-width: 2px; border-style: solid; }
    .box.consider { background: rgba(16, 185, 129, 0.28); border-color: #34d399; color: #ecfdf5; }
    .box.aside { background: rgba(245, 158, 11, 0.18); border-color: #fbbf24; color: #fffbeb; }
    .sym { font-family: ui-monospace, monospace; font-weight: 750; font-size: 0.9rem; }
    .sub { margin-top: 0.22rem; font-family: ui-monospace, monospace; font-size: 0.7rem; }
    .plan, .keys { display: none; }
    .plan { flex-direction: column; border: 2px solid rgba(56, 189, 248, 0.7); border-radius: 0.55rem; background: #1a2140; padding: 0.75rem; }
    .plan-head, .keys-top { display: flex; justify-content: space-between; gap: 0.5rem; align-items: flex-start; }
    .plan h2, .keys strong { font-family: ui-monospace, monospace; margin: 0; }
    .name, .reason, .keys p { color: #c7d2fe; }
    .badge { margin: 0; border-radius: 0.35rem; padding: 0.22rem 0.45rem; font-size: 0.75rem; font-weight: 750; }
    .badge.consider { background: #10b981; color: #052e1c; }
    .badge.aside { background: #fbbf24; color: #451a03; }
    .stats, .keys dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; margin: 0.6rem 0; }
    .keys dl { grid-template-columns: repeat(4, 1fr); margin: 0.35rem 0 0; }
    .stats div, .keys dl div { background: rgba(255,255,255,0.04); border-radius: 0.35rem; padding: 0.3rem 0.4rem; }
    dt { font-size: 0.62rem; letter-spacing: 0.04em; text-transform: uppercase; color: #a1a1aa; }
    dd { margin: 0; font-family: ui-monospace, monospace; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
    .plan p { margin: 0.4rem 0 0; font-size: 0.75rem; line-height: 1.4; }
    .keys { flex-direction: column; position: sticky; top: 0; background: rgba(18, 22, 42, 0.96); border-bottom: 2px solid rgba(129, 140, 248, 0.45); padding: 0.45rem 0.2rem 0.55rem; z-index: 2; }
    .keys-top span, .keys p { font-size: 0.7rem; }
    .targets { margin: 0.55rem 1rem 0.75rem; border: 2px solid rgba(129, 140, 248, 0.7); border-radius: 0.55rem; background: #1a2140; }
    .targets-head { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; padding: 0.7rem 0.85rem; }
    .targets-head h2 { margin: 0; font-size: 1.05rem; font-weight: 750; letter-spacing: -0.01em; color: #f8fafc; }
    .indicators-head h2 { margin: 0; font-size: 0.95rem; font-weight: 750; letter-spacing: -0.01em; color: #f8fafc; }
    .targets-head p, .targets-note { margin: 0; color: #c7d2fe; font-size: 0.85rem; line-height: 1.35; }
    .indicators-note { margin: 0; color: #c7d2fe; font-size: 0.75rem; }
    .rates { text-align: right; }
    .targets-scroll { border-top: 1px solid rgba(255,255,255,0.08); overflow-x: auto; }
    .targets table { width: 100%; border-collapse: collapse; font-size: 0.95rem; line-height: 1.4; }
    .indicators table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
    .targets th, .targets td { text-align: left; padding: 0.45rem 0.7rem; border-top: 1px solid rgba(255,255,255,0.08); vertical-align: middle; white-space: nowrap; }
    .indicators th, .indicators td { text-align: left; padding: 0.22rem 0.55rem; border-top: 1px solid rgba(255,255,255,0.08); vertical-align: top; }
    .targets th { color: #c7d2fe; font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 750; }
    .indicators th { color: #c7d2fe; font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 750; }
    .targets tr.group td { font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 750; background: #12162a; padding-top: 0.6rem; padding-bottom: 0.4rem; }
    .targets tr.empty td { color: #a1a1aa; }
    .targets .sym { font-family: ui-monospace, monospace; font-weight: 750; font-size: inherit; }
    .long { color: #34d399; }
    .short { color: #ef4444; }
    .targets tr.side-long { box-shadow: inset 4px 0 0 #34d399; }
    .targets tr.side-short { box-shadow: inset 4px 0 0 #ef4444; }
    .plan-side { display: flex; align-items: center; gap: 0.4rem; margin: 0; font-weight: 750; }
    .targets td:nth-child(3), .targets td:nth-child(4), .targets td.conf { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .reached { color: #34d399; font-weight: 750; }
    .not-reached { color: #fb7185; font-weight: 750; }
    .open { color: #38bdf8; font-weight: 750; }
    .targets-note { padding: 0.45rem 0.75rem 0.55rem; border-top: 1px solid rgba(255,255,255,0.12); }
    .mood { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin: 0.6rem 1rem 0; border: 2px solid #818cf8; border-radius: 0.55rem; background: #1a2140; padding: 0.5rem 0.7rem; }
    .mood-name { margin: 0; border-radius: 0.35rem; padding: 0.2rem 0.5rem; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; white-space: nowrap; }
    .mood p { margin: 0; color: #f8fafc; font-size: 0.88rem; line-height: 1.4; font-weight: 550; }
    .mood.risk-on { border-color: #34d399; }
    .mood.risk-on .mood-name { background: #10b981; color: #052e1c; }
    .mood.mixed { border-color: #fbbf24; }
    .mood.mixed .mood-name { background: #fbbf24; color: #451a03; }
    .mood.risk-off { border-color: #fb7185; }
    .mood.risk-off .mood-name { background: #f43f5e; color: #fff; }
    .timing { margin: 0.45rem 0 0; font-size: 0.88rem; font-weight: 750; line-height: 1.35; }
    .timing.take { color: #34d399; }
    .timing.wait { color: #fbbf24; }
    .indicators { margin: 0.5rem 1rem 0; border: 2px solid rgba(56, 189, 248, 0.75); border-radius: 0.55rem; background: #1a2140; }
    .indicators-head { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; padding: 0.45rem 0.7rem; }
    .indicators-head p { margin: 0; color: #7dd3fc; font-size: 0.85rem; font-weight: 650; }
    .indicators-scroll { overflow-x: auto; border-top: 1px solid rgba(255,255,255,0.08); }
    .indicators table { table-layout: fixed; }
    .indicators td:nth-child(1), .indicators th:nth-child(1) { width: 28%; }
    .indicators td:nth-child(2), .indicators th:nth-child(2) { width: 24%; }
    .indicators td:nth-child(4), .indicators th:nth-child(4) { width: 4.25rem; white-space: nowrap; }
    .indicators td.stat { font-family: ui-monospace, monospace; font-size: 0.7rem; font-variant-numeric: tabular-nums; }
    .indicators td.with { color: #34d399; font-weight: 800; }
    .indicators td.against { color: #fbbf24; font-weight: 800; }
    .indicators-note { padding: 0.3rem 0.65rem 0.4rem; border-top: 1px solid rgba(255,255,255,0.08); }
    .mobile-keys { display: none; }
    @media (max-width: 860px) {
      .board { display: flex; flex-direction: column; }
      .mobile-keys { display: block; order: 0; position: sticky; top: 0; background: rgba(18, 22, 42, 0.96); z-index: 3; }
      .grid { order: 1; grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .plans { order: 2; }
    }
    ${rules}
  </style>
</head>
<body>
  <header class="site">
    <div>
      <h1>Intratrade</h1>
      <p class="meta">${escapeHtml(meta)}</p>
    </div>
    <p class="counts"><span class="consider-count">${consider} consider</span> · <span class="aside-count">${aside} stand aside</span></p>
  </header>
  ${renderMood(mood)}
  ${renderIndicators(indicators)}
  ${renderTargets(tracked, mood)}
  ${radios}
  <main class="board">
    <div class="mobile-keys">${keys}</div>
    <div class="grid" role="listbox" aria-label="Liquid book">${boxes}</div>
    <div class="plans">${plans}</div>
  </main>
  <footer>Decision support only. Nothing here sends an order.</footer>
</body>
</html>
`;
}

const session = await loadPublicSession();
if (session.source !== "live" || session.snapshots.length === 0) {
  console.error("Refusing to publish: Yahoo did not return a live book. The current page is unchanged.");
  process.exit(1);
}
if (/sample/i.test(session.feed) || session.fallbackError) {
  console.error("Refusing to publish the sample tape. The current page is unchanged.");
  process.exit(1);
}
if (session.snapshots.some((snapshot) => !Number.isFinite(snapshot.last) || snapshot.last <= 0)) {
  console.error("Refusing to publish: a quote was missing a price. The current page is unchanged.");
  process.exit(1);
}

const ideas = rankIdeas(session.snapshots, DEFAULT_RISK);
const tracked = await trackBook(session);
const meta = `${session.delayLabel}${session.note.title ? ` · ${session.note.title}.` : ""}${session.note.detail ? ` ${session.note.detail}` : ""}`;
const html = render(ideas, meta, session.asOf, tracked, session.mood ?? null, session.indicators ?? null);
if (/sample tape|built-in sample|sample wire/i.test(html)) {
  console.error("Refusing to publish: the rendered page looks like the sample tape.");
  process.exit(1);
}

writeFileSync("index.html.next", html);
renameSync("index.html.next", "index.html");

const consider = ideas.filter((idea) => idea.stance === "consider").map((idea) => idea.symbol);
console.log(`ASOF ${session.asOf}`);
console.log(`DELAY ${session.delayLabel}`);
const indicators = session.indicators;
console.log(
  `INDICATORS ${
    indicators?.rows.map((row) => `${row.factor} [${row.period}] ${row.statistic} ${row.alignment}`).join(" || ") ||
    "(none)"
  }`,
);
console.log(`OMITTED ${indicators?.omitted.join(" | ") || "(none)"}`);
console.log(`CONSIDER ${consider.join(", ") || "(none)"}`);
console.log(`ASIDE ${ideas.length - consider.length}`);
console.log(`THROUGH ${tracked.through ?? "(none)"}`);
console.log(`REACHED ${tracked.calls.filter((call) => call.status === "reached").map((call) => call.symbol).join(", ") || "(none)"}`);
console.log(`NOT_REACHED ${tracked.calls.filter((call) => call.status === "not-reached").map((call) => `${call.symbol} ${call.target}`).join(", ") || "(none)"}`);
console.log(`OPEN ${tracked.calls.filter((call) => call.status === "open").map((call) => `${call.symbol} ${call.target}`).join(", ") || "(none)"}`);
