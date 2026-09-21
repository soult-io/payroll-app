/**
 * Spec 17 chunk B — pure rendering of the pay-verify dashboard.
 *
 * Takes verify-summary history (newest-first after {@link sortByGeneratedAtDesc})
 * and returns a single self-contained, PII-free HTML document: no external
 * requests, inline CSS, light/dark. No filesystem access lives here — the
 * generator (`generate.ts`) reads/writes and calls {@link renderPage}.
 */

import type { Outcome, SuiteResult, VerifySummary } from "@payroll/verify-summary";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Human duration: "820ms", "3.2s", "4m 05s". */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs - m * 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function shortSha(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** Pass rate over non-skipped tests, 0–100 (100 when nothing ran). */
export function passRate(summary: VerifySummary): number {
  const ran = summary.counts.passed + summary.counts.failed;
  return ran === 0 ? 100 : (summary.counts.passed / ran) * 100;
}

export function sortByGeneratedAtDesc(history: VerifySummary[]): VerifySummary[] {
  // ISO-8601 UTC strings sort lexically; no localeCompare (repo bans it).
  return [...history].sort((a, b) => {
    if (a.generatedAt < b.generatedAt) return 1;
    if (a.generatedAt > b.generatedAt) return -1;
    return 0;
  });
}

function outcomeClass(status: Outcome): string {
  return status === "passed" ? "pass" : "fail";
}

function badge(status: Outcome): string {
  const label = status === "passed" ? "PASSED" : "FAILED";
  return `<span class="badge ${outcomeClass(status)}">${label}</span>`;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? escapeHtml(iso)
    : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function suiteRow(suite: SuiteResult): string {
  const c = suite.counts;
  return `<tr>
      <td>${escapeHtml(suite.name)}</td>
      <td>${badge(suite.status)}</td>
      <td class="num">${c.passed}</td>
      <td class="num">${c.failed}</td>
      <td class="num">${c.skipped}</td>
      <td class="num">${c.total}</td>
      <td class="num">${formatDurationMs(suite.durationMs)}</td>
    </tr>`;
}

function historyRow(summary: VerifySummary): string {
  const rate = passRate(summary).toFixed(0);
  return `<tr>
      <td>${formatInstant(summary.generatedAt)}</td>
      <td>${badge(summary.overallStatus)}</td>
      <td class="mono">${escapeHtml(summary.source)}</td>
      <td class="mono">${escapeHtml(shortSha(summary.gitSha))}</td>
      <td class="num">${summary.counts.passed}/${summary.counts.total}</td>
      <td>
        <span class="bar" title="${rate}% pass"><span class="bar-fill ${outcomeClass(summary.overallStatus)}" style="width:${rate}%"></span></span>
      </td>
    </tr>`;
}

function suiteTable(latest: VerifySummary): string {
  const rows = latest.suites.map(suiteRow).join("\n");
  return `<table class="suites">
      <thead><tr><th>Suite</th><th>Status</th><th>Pass</th><th>Fail</th><th>Skip</th><th>Total</th><th>Duration</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted">no suites reported</td></tr>`}</tbody>
    </table>`;
}

function historyTable(history: VerifySummary[]): string {
  const rows = history.map(historyRow).join("\n");
  return `<table class="history">
      <thead><tr><th>Run</th><th>Status</th><th>Source</th><th>Commit</th><th>Passed</th><th>Pass rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function headerCard(latest: VerifySummary, reportHref: string | undefined): string {
  const c = latest.counts;
  const report = reportHref
    ? `<a class="report" href="${escapeHtml(reportHref)}">View full test report →</a>`
    : "";
  return `<section class="card status ${outcomeClass(latest.overallStatus)}">
      <div class="status-head">
        <h1>payroll-app — QA verification</h1>
        ${badge(latest.overallStatus)}
      </div>
      <p class="meta">
        <span>${formatInstant(latest.generatedAt)}</span> ·
        <span class="mono">${escapeHtml(latest.source)}</span> ·
        <span class="mono">${escapeHtml(shortSha(latest.gitSha))}</span>
      </p>
      <p class="counts">
        <strong>${c.passed}</strong> passed · <strong>${c.failed}</strong> failed ·
        <strong>${c.skipped}</strong> skipped · ${c.total} total
      </p>
      ${report}
    </section>`;
}

const EMPTY_PAGE_BODY = `<section class="card status pass">
      <div class="status-head"><h1>payroll-app — QA verification</h1></div>
      <p class="muted">No verification runs ingested yet. The dashboard populates after the first CI or nightly run publishes a summary.</p>
    </section>`;

export interface RenderOptions {
  /** Relative href to the copied Playwright html report, when present. */
  reportHref?: string | undefined;
  /** Max history rows to render (default 30). */
  historyLimit?: number | undefined;
}

/** Render the full dashboard document from newest-first history. */
export function renderPage(history: VerifySummary[], options: RenderOptions = {}): string {
  const sorted = sortByGeneratedAtDesc(history);
  const latest = sorted[0];
  const limit = options.historyLimit ?? 30;
  const body = latest
    ? `${headerCard(latest, options.reportHref)}
    <section class="card">
      <h2>Suites</h2>
      ${suiteTable(latest)}
    </section>
    <section class="card">
      <h2>Recent runs</h2>
      ${historyTable(sorted.slice(0, limit))}
    </section>`
    : EMPTY_PAGE_BODY;
  return renderDocument(body);
}

function renderDocument(body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>payroll-app QA verification</title>
<meta name="description" content="PII-free QA verification status for payroll-app — synthetic data only.">
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
    <footer class="muted">
      Synthetic data only — no employee PII. Generated ${formatInstant(new Date().toISOString())} · summary schema v1.
    </footer>
</main>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24; --muted: #5b6570;
  --border: #e2e6ea; --pass: #1f8a4c; --pass-bg: #e7f6ec; --fail: #c62828; --fail-bg: #fdeaea;
}
:root:not([data-theme="light"]) {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1216; --panel: #171b21; --ink: #e6e9ec; --muted: #9aa4af;
    --border: #262c34; --pass: #4ccb7d; --pass-bg: #12321f; --fail: #f0716f; --fail-bg: #3a1b1b;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1216; --panel: #171b21; --ink: #e6e9ec; --muted: #9aa4af;
  --border: #262c34; --pass: #4ccb7d; --pass-bg: #12321f; --fail: #f0716f; --fail-bg: #3a1b1b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.35rem; margin: 0; }
h2 { font-size: 1.05rem; margin: 0 0 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 18px 20px; margin: 0 0 18px; }
.status { border-left: 6px solid var(--muted); }
.status.pass { border-left-color: var(--pass); }
.status.fail { border-left-color: var(--fail); }
.status-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.meta, .counts { margin: 8px 0 0; color: var(--muted); }
.counts strong { color: var(--ink); }
.badge { font: 700 0.72rem/1 ui-monospace, monospace; letter-spacing: .04em; padding: 5px 9px;
  border-radius: 999px; white-space: nowrap; }
.badge.pass { color: var(--pass); background: var(--pass-bg); }
.badge.fail { color: var(--fail); background: var(--fail-bg); }
.report { display: inline-block; margin-top: 12px; color: var(--pass); font-weight: 600; text-decoration: none; }
.report:hover { text-decoration: underline; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .03em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
.muted { color: var(--muted); }
.bar { display: inline-block; width: 120px; max-width: 40vw; height: 8px; border-radius: 999px;
  background: var(--border); overflow: hidden; vertical-align: middle; }
.bar-fill { display: block; height: 100%; }
.bar-fill.pass { background: var(--pass); }
.bar-fill.fail { background: var(--fail); }
footer { margin-top: 24px; font-size: 0.82rem; text-align: center; }
`;
