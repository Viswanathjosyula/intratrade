import { renameSync, writeFileSync } from "node:fs";

import { earningsRead, price, rewardRisk, sentimentLabel, sideLabel, stanceLabel } from "@/lib/format";
import { trackBook, type TrackedBook } from "@/lib/market/call-log";
import type { CallStatus } from "@/lib/market/calls";
import { rankIdeas } from "@/lib/market/engine";
import { loadPublicSession } from "@/lib/market/live";
import { estimatedReach, formatSessionDate, reachLabel } from "@/lib/market/reach";
import { DEFAULT_RISK, type TradeIdea } from "@/lib/market/types";

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

function renderTargets(tracked: TrackedBook): string {
  const reached = tracked.calls.filter((call) => call.status === "reached").length;
  const missed = tracked.calls.filter((call) => call.status === "not-reached").length;
  const open = tracked.calls.filter((call) => call.status === "open").length;
  const rows =
    tracked.calls.length === 0
      ? `<tr><td colspan="5">No published consider call is in the log yet.</td></tr>`
      : tracked.calls
          .map(
            (call) => `<tr>
          <td class="sym">${escapeHtml(call.symbol)}</td>
          <td>${escapeHtml(sideLabel(call.side))}</td>
          <td>${price(call.target)}</td>
          <td>${escapeHtml(formatSessionDate(call.asOf))}</td>
          <td class="${call.status}">${statusText(call.status)}</td>
        </tr>`,
          )
          .join("\n");
  const checked = tracked.through
    ? `Checked against Yahoo regular-session bars through ${formatSessionDate(tracked.through)}.`
    : "Yahoo bars were not available, so every row stays open.";
  const gap = tracked.incomplete ? " Names with no confirming bars stay open." : "";
  return `<section class="targets" aria-label="Target tracking">
    <div class="targets-head">
      <h2>Targets</h2>
      <p><span class="reached">${reached} reached</span> · <span class="not-reached">${missed} not reached</span> · <span class="open">${open} open</span></p>
    </div>
    <div class="targets-scroll">
      <table>
        <thead><tr><th>Name</th><th>Side</th><th>Target</th><th>As of</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="targets-note">${escapeHtml(`${checked}${gap}`)} This table does not send an order.</p>
  </section>`;
}

function render(ideas: TradeIdea[], meta: string, asOf: string, tracked: TrackedBook): string {
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
        <div class="keys-top"><strong>${escapeHtml(idea.symbol)}</strong><span>${escapeHtml(sideLabel(idea.side))} · ${escapeHtml(stanceLabel(idea.stance))}</span></div>
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
        `<label class="box ${idea.stance === "consider" ? "consider" : "aside"}" for="pick-${idea.symbol}"><span class="sym">${escapeHtml(idea.symbol)}</span><span class="sub">${escapeHtml(sideLabel(idea.side))} · ${price(idea.last)}</span></label>`,
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
      return `<article class="plan plan-${idea.symbol}">
        <header class="plan-head">
          <div><h2>${escapeHtml(idea.symbol)}</h2><p class="name">${escapeHtml(idea.name)}</p></div>
          <p class="badge ${tone}">${escapeHtml(sideLabel(idea.side))} · ${escapeHtml(stanceLabel(idea.stance))}</p>
        </header>
        <dl class="stats">
          <div><dt>Last</dt><dd>${price(idea.last)}</dd></div>
          <div><dt>Target</dt><dd>${price(idea.target)}</dd></div>
          <div><dt>Stop</dt><dd>${price(idea.stop)}</dd></div>
          <div><dt>Reward:risk</dt><dd>${rewardRisk(idea.riskReward)}</dd></div>
        </dl>
        <p class="reach">${escapeHtml(reach)}</p>
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
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #221f1c; color: #f5f5f4; }
    header.site, footer { padding: 0.7rem 1rem; border-bottom: 1px solid #44403c; }
    footer { border-bottom: 0; border-top: 1px solid #44403c; color: #a8a29e; font-size: 0.75rem; text-align: center; }
    header.site { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
    header.site h1 { margin: 0; font-size: 1.05rem; }
    .meta { margin: 0.35rem 0 0; color: #a8a29e; font-size: 0.75rem; line-height: 1.4; }
    .counts { color: #a8a29e; font-size: 0.75rem; white-space: nowrap; }
    .consider-count { color: #6ee7b7; }
    .aside-count { color: #fde68a; }
    .pick { position: absolute; opacity: 0; pointer-events: none; }
    .board { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(17rem, 0.8fr); gap: 0.75rem; padding: 0.75rem 1rem 1rem; min-height: calc(100vh - 8.5rem); }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-auto-rows: minmax(3rem, 1fr); gap: 0.35rem; }
    .box { display: flex; flex-direction: column; justify-content: center; border-radius: 0.4rem; padding: 0.35rem 0.45rem; cursor: pointer; min-height: 3rem; }
    .box.consider { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.45); color: #ecfdf5; }
    .box.aside { background: rgba(69, 26, 3, 0.55); border: 1px solid rgba(180, 83, 9, 0.45); color: #fffbeb; }
    .sym { font-family: ui-monospace, monospace; font-weight: 650; font-size: 0.9rem; }
    .sub { margin-top: 0.25rem; font-family: ui-monospace, monospace; font-size: 0.68rem; opacity: 0.8; }
    .plan, .keys { display: none; }
    .plan { flex-direction: column; border: 1px solid #44403c; border-radius: 0.5rem; background: #292524; padding: 0.7rem; overflow: auto; }
    .plan-head, .keys-top { display: flex; justify-content: space-between; gap: 0.5rem; align-items: flex-start; }
    .plan h2, .keys strong { font-family: ui-monospace, monospace; margin: 0; }
    .name, .reason, .meta, .keys p { color: #a8a29e; }
    .badge { margin: 0; border-radius: 0.35rem; padding: 0.25rem 0.4rem; font-size: 0.75rem; }
    .badge.consider { background: rgba(16, 185, 129, 0.18); color: #a7f3d0; }
    .badge.aside { background: rgba(251, 191, 36, 0.12); color: #fde68a; }
    .stats, .keys dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; margin: 0.6rem 0; }
    .keys dl { grid-template-columns: repeat(4, 1fr); margin: 0.35rem 0 0; }
    .stats div, .keys dl div { background: rgba(68, 64, 60, 0.45); border-radius: 0.35rem; padding: 0.3rem 0.4rem; }
    dt { font-size: 0.62rem; letter-spacing: 0.04em; text-transform: uppercase; color: #a8a29e; }
    dd { margin: 0; font-family: ui-monospace, monospace; font-size: 0.9rem; }
    .plan p { margin: 0.45rem 0 0; font-size: 0.78rem; line-height: 1.35; }
    .keys { flex-direction: column; position: sticky; top: 0; background: #221f1c; border-bottom: 1px solid #44403c; padding: 0.45rem 0.2rem 0.55rem; z-index: 2; }
    .keys-top span, .keys p { font-size: 0.7rem; }
    .targets { margin: 0 1rem 0.75rem; border: 1px solid #44403c; border-radius: 0.5rem; background: #292524; }
    .targets-head { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; padding: 0.4rem 0.65rem; }
    .targets-head h2 { margin: 0; font-size: 0.9rem; }
    .targets-head p, .targets-note { margin: 0; color: #a8a29e; font-size: 0.72rem; }
    .targets-scroll { max-height: 9.5rem; overflow: auto; border-top: 1px solid #44403c; }
    .targets table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
    .targets th, .targets td { text-align: left; padding: 0.22rem 0.55rem; border-top: 1px solid #44403c; }
    .targets th { position: sticky; top: 0; background: #292524; color: #a8a29e; font-size: 0.62rem; letter-spacing: 0.04em; text-transform: uppercase; }
    .targets .sym { font-family: ui-monospace, monospace; font-weight: 650; }
    .targets td:nth-child(3), .targets td:nth-child(4) { font-family: ui-monospace, monospace; }
    .reached { color: #6ee7b7; }
    .not-reached { color: #fecdd3; }
    .open { color: #d6d3d1; }
    .targets-note { padding: 0.3rem 0.65rem 0.4rem; border-top: 1px solid #44403c; }
    .mobile-keys { display: none; }
    @media (max-width: 860px) {
      .board { display: flex; flex-direction: column; min-height: 0; }
      .mobile-keys { display: block; order: 0; position: sticky; top: 0; background: rgba(34, 31, 28, 0.96); z-index: 3; }
      .grid { order: 1; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: auto; }
      .plans { order: 2; }
      .plan { max-height: none; }
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
  ${renderTargets(tracked)}
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
const html = render(ideas, meta, session.asOf, tracked);
if (/sample tape|built-in sample|sample wire/i.test(html)) {
  console.error("Refusing to publish: the rendered page looks like the sample tape.");
  process.exit(1);
}

writeFileSync("index.html.next", html);
renameSync("index.html.next", "index.html");

const consider = ideas.filter((idea) => idea.stance === "consider").map((idea) => idea.symbol);
console.log(`ASOF ${session.asOf}`);
console.log(`DELAY ${session.delayLabel}`);
console.log(`CONSIDER ${consider.join(", ") || "(none)"}`);
console.log(`ASIDE ${ideas.length - consider.length}`);
console.log(`THROUGH ${tracked.through ?? "(none)"}`);
console.log(`REACHED ${tracked.calls.filter((call) => call.status === "reached").map((call) => call.symbol).join(", ") || "(none)"}`);
console.log(`NOT_REACHED ${tracked.calls.filter((call) => call.status === "not-reached").map((call) => `${call.symbol} ${call.target}`).join(", ") || "(none)"}`);
console.log(`OPEN ${tracked.calls.filter((call) => call.status === "open").map((call) => `${call.symbol} ${call.target}`).join(", ") || "(none)"}`);
