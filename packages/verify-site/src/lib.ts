/**
 * Spec 17 chunk B — pure rendering of the pay-verify dashboard.
 *
 * Takes verify-summary history (newest-first after {@link sortByGeneratedAtDesc})
 * and returns a single self-contained, PII-free HTML document: no external
 * requests, inline CSS, light/dark. No filesystem access lives here — the
 * generator (`generate.ts`) reads/writes and calls {@link renderPage}.
 */

import type {
  Outcome,
  SuiteResult,
  TestResult,
  TestStatus,
  VerifySummary,
} from "@payroll/verify-summary";

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

/**
 * Clean-pass rate over executed tests, 0–100 (100 when nothing ran).
 * A flake is executed but is not a clean pass, so it lowers the bar it sits on.
 */
export function passRate(summary: VerifySummary): number {
  const ran = summary.counts.executed;
  return ran === 0 ? 100 : (summary.counts.passed / ran) * 100;
}

/**
 * Spec 18 — `fullName` → the `generatedAt` of the most recent summary in which
 * that test actually EXECUTED (passed, failed or flaked).
 *
 * Deliberately computed across the whole ingested history rather than stored
 * per summary: one run cannot know what other runs did, and the question
 * "has this test ever run?" is only answerable over the window.
 */
export function lastExecutedAtByTest(history: VerifySummary[]): Map<string, string> {
  const seen = new Map<string, string>();
  for (const summary of history) {
    for (const suite of summary.suites) {
      for (const test of suite.tests) {
        if (test.status === "skipped") continue;
        const prev = seen.get(test.fullName);
        if (prev === undefined || prev < summary.generatedAt) {
          seen.set(test.fullName, summary.generatedAt);
        }
      }
    }
  }
  return seen;
}

/** A test skipped in this run that no retained run has ever executed. */
function isNeverRun(test: TestResult, lastExecuted: Map<string, string>): boolean {
  return test.status === "skipped" && !lastExecuted.has(test.fullName);
}

export function sortByGeneratedAtDesc(history: VerifySummary[]): VerifySummary[] {
  // ISO-8601 UTC strings sort lexically; no localeCompare (repo bans it).
  return [...history].sort((a, b) => {
    if (a.generatedAt < b.generatedAt) return 1;
    if (a.generatedAt > b.generatedAt) return -1;
    return 0;
  });
}

const OUTCOME_CLASS: Record<Outcome, string> = {
  passed: "pass",
  passed_with_flakes: "flake",
  failed: "fail",
  not_run: "skip",
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "PASSED",
  // Spelled out rather than shortened: the whole point of spec 18 is that this
  // state must not be mistakable for a clean pass at a glance.
  passed_with_flakes: "PASSED (FLAKY)",
  failed: "FAILED",
  not_run: "NOT RUN",
};

function outcomeClass(status: Outcome): string {
  return OUTCOME_CLASS[status];
}

function badge(status: Outcome): string {
  return `<span class="badge ${outcomeClass(status)}">${OUTCOME_LABEL[status]}</span>`;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? escapeHtml(iso)
    : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function suiteRow(suite: SuiteResult, lastExecuted: Map<string, string>): string {
  const c = suite.counts;
  const never = suite.tests.filter((t) => isNeverRun(t, lastExecuted)).length;
  // Same rule as the headline: a suite is not simply PASSED while part of it
  // has never been proven. Kept consistent so the page does not contradict
  // itself one level down.
  const status =
    never > 0 && suite.status !== "failed"
      ? `<span class="badge flake">${OUTCOME_LABEL[suite.status]} · ${never} NEVER RUN</span>`
      : badge(suite.status);
  return `<tr>
      <td>${escapeHtml(suite.name)}</td>
      <td>${status}</td>
      <td class="num">${c.passed}</td>
      <td class="num">${c.flaky ?? "—"}</td>
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

function suiteTable(latest: VerifySummary, lastExecuted: Map<string, string>): string {
  const rows = latest.suites.map((s) => suiteRow(s, lastExecuted)).join("\n");
  return `<table class="suites">
      <thead><tr><th>Suite</th><th>Status</th><th>Pass</th><th>Flaky</th><th>Fail</th><th>Skip</th><th>Total</th><th>Duration</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="8" class="muted">no suites reported</td></tr>`}</tbody>
    </table>`;
}

function historyTable(history: VerifySummary[]): string {
  const rows = history.map(historyRow).join("\n");
  return `<table class="history">
      <thead><tr><th>Run</th><th>Status</th><th>Source</th><th>Commit</th><th>Passed</th><th>Pass rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function headerCard(
  latest: VerifySummary,
  reportHref: string | undefined,
  neverRun: number,
): string {
  const c = latest.counts;
  const report = reportHref
    ? `<a class="report" href="${escapeHtml(reportHref)}">View full test report →</a>`
    : "";
  // A run can be green on everything it executed and still have left whole
  // journeys unproven. The headline says so rather than making the reader find
  // it further down the page — that omission is what made the old dashboard
  // untrustworthy (spec 18).
  const headline =
    neverRun > 0 && latest.overallStatus !== "failed"
      ? `<span class="badge flake">${OUTCOME_LABEL[latest.overallStatus]} · ${neverRun} NEVER RUN</span>`
      : badge(latest.overallStatus);
  const edge =
    neverRun > 0 && latest.overallStatus === "passed"
      ? "flake"
      : outcomeClass(latest.overallStatus);
  // Absent flaky count means UNKNOWN (an upgraded v1 run), so print nothing —
  // "0 flaky" would assert something the file cannot support.
  const flaky = c.flaky === undefined ? "" : ` <strong>${c.flaky}</strong> flaky ·`;
  const never = neverRun > 0 ? ` <strong>${neverRun}</strong> never run ·` : "";
  return `<section class="card status ${edge}">
      <div class="status-head">
        <h1>payroll-app — QA verification</h1>
        ${headline}
      </div>
      <p class="meta">
        <span>${formatInstant(latest.generatedAt)}</span> ·
        <span class="mono">${escapeHtml(latest.source)}</span> ·
        <span class="mono">${escapeHtml(shortSha(latest.gitSha))}</span>
      </p>
      <p class="counts">
        <strong>${c.passed}</strong> passed ·${flaky} <strong>${c.failed}</strong> failed ·
        <strong>${c.skipped}</strong> skipped ·${never} ${c.total} total
        <span class="muted">(${c.executed} executed)</span>
      </p>
      ${report}
    </section>`;
}

// --- chunk C: rich cards (per-journey e2e + tax-worksheet correctness) ----

function testStatusClass(status: TestStatus): string {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "flaky") return "flake";
  return "skip";
}

function testBadge(status: TestStatus): string {
  const label =
    status === "passed"
      ? "PASS"
      : status === "failed"
        ? "FAIL"
        : status === "flaky"
          ? "FLAKY"
          : "SKIP";
  return `<span class="badge ${testStatusClass(status)}">${label}</span>`;
}

/** Reporter file basename minus the .test.ts / .spec.ts suffix. */
function testFileKey(file: string | undefined): string {
  if (!file) return "";
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.(test|spec)\.[tj]s$/, "");
}

interface TaxGroup {
  title: string;
  files: string[];
}

// The descriptive test titles carry the expected figures (e.g. "zero credit →
// 6.0% net, $420 per employee"), so a passing check IS the expected-vs-actual
// proof. Groups are matched by reporter file basename.
const TAX_GROUPS: TaxGroup[] = [
  { title: "Form 940 / FUTA", files: ["futa-credit", "futa-cap", "in-year-940", "f940-pdf"] },
  { title: "Form 941", files: ["f941-pdf"] },
  { title: "W-2 / W-3 & annual forms", files: ["annual-forms"] },
  { title: "State income-tax withholding", files: ["state-taxes"] },
  {
    title: "Filings & deposits",
    files: ["filings", "filing-recompute", "deposits", "deposit-attachments", "filing-attachments"],
  },
];

// Tests eligible for tax classification — everything except the e2e suite,
// whose specs are shown as their own journey cards (never as tax checks).
function taxCandidateTests(latest: VerifySummary): TestResult[] {
  return latest.suites.filter((s) => s.key !== "e2e").flatMap((s) => s.tests);
}

function checkItem(test: TestResult): string {
  return `<li>
        <span class="check-name">${escapeHtml(test.name)}</span>
        <span class="check-meta">${formatDurationMs(test.durationMs)} ${testBadge(test.status)}</span>
      </li>`;
}

function groupOutcome(tests: TestResult[]): Outcome {
  if (tests.some((t) => t.status === "failed")) return "failed";
  if (tests.every((t) => t.status === "skipped")) return "not_run";
  if (tests.some((t) => t.status === "flaky")) return "passed_with_flakes";
  return "passed";
}

function taxCard(title: string, tests: TestResult[]): string {
  const failing = tests.filter((t) => t.status === "failed").length;
  const items = tests.map(checkItem).join("\n");
  return `<article class="tcard">
      <div class="tcard-head"><h3>${escapeHtml(title)}</h3>${badge(groupOutcome(tests))}</div>
      <p class="muted small">${tests.length} checks · ${failing} failing</p>
      <ul class="checks">${items}</ul>
    </article>`;
}

function provenance(latest: VerifySummary): string {
  return `${escapeHtml(latest.source)} · ${escapeHtml(shortSha(latest.gitSha))} · ${formatInstant(latest.generatedAt)}`;
}

function taxCardsSection(latest: VerifySummary): string {
  const tests = taxCandidateTests(latest);
  const cards: string[] = [];
  for (const group of TAX_GROUPS) {
    const groupTests = tests.filter((t) => group.files.includes(testFileKey(t.file)));
    if (groupTests.length > 0) cards.push(taxCard(group.title, groupTests));
  }
  if (cards.length === 0) return "";
  return `<section class="card">
      <h2>Tax-worksheet correctness</h2>
      <p class="prov">The check titles state the expected figures; a passing check is the expected-vs-actual proof. Run ${provenance(latest)}.</p>
      <div class="cards">${cards.join("\n")}</div>
    </section>`;
}

/**
 * The line under a journey's title — what the card actually claims.
 * A skip is never left to speak for itself: it says why, and either when it
 * last ran or that it never has.
 */
function journeyDetail(test: TestResult, lastExecuted: Map<string, string>): string {
  const reason = test.skipReason ? escapeHtml(test.skipReason) : "no reason recorded by the suite";
  if (isNeverRun(test, lastExecuted)) {
    return `<p class="muted small">Never executed in any retained run — ${reason}</p>`;
  }
  if (test.status === "skipped") {
    const at = lastExecuted.get(test.fullName);
    const when = at ? ` · last ran ${formatInstant(at)}` : "";
    return `<p class="muted small">${reason}${when}</p>`;
  }
  if (test.status === "flaky") {
    const why = test.firstFailure ? ` · first attempt: ${escapeHtml(test.firstFailure)}` : "";
    const tries = test.attempts ? `${test.attempts} attempts` : "passed on retry";
    return `<p class="muted small">${formatDurationMs(test.durationMs)} · ${tries}${why}</p>`;
  }
  return `<p class="muted small">${formatDurationMs(test.durationMs)}</p>`;
}

function journeyCard(test: TestResult, lastExecuted: Map<string, string>): string {
  const never = isNeverRun(test, lastExecuted);
  const edge = never ? "never" : testStatusClass(test.status);
  const chip = never ? `<span class="badge never">NEVER RUN</span>` : testBadge(test.status);
  return `<article class="tcard ${edge}-edge">
      <div class="tcard-head"><h3>${escapeHtml(test.name)}</h3>${chip}</div>
      ${journeyDetail(test, lastExecuted)}
    </article>`;
}

function journeyCardsSection(latest: VerifySummary, lastExecuted: Map<string, string>): string {
  const e2e = latest.suites.find((s) => s.key === "e2e");
  if (!e2e || e2e.tests.length === 0) return "";
  const cards = e2e.tests.map((t) => journeyCard(t, lastExecuted)).join("\n");
  return `<section class="card">
      <h2>End-to-end journeys</h2>
      <p class="prov">Each card is a Playwright user journey. Run ${provenance(latest)}.</p>
      <div class="cards">${cards}</div>
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
  const lastExecuted = lastExecutedAtByTest(sorted);
  const neverRun = latest
    ? latest.suites.flatMap((s) => s.tests).filter((t) => isNeverRun(t, lastExecuted)).length
    : 0;
  const body = latest
    ? `${headerCard(latest, options.reportHref, neverRun)}
    <section class="card">
      <h2>Suites</h2>
      ${suiteTable(latest, lastExecuted)}
    </section>
    ${journeyCardsSection(latest, lastExecuted)}
    ${taxCardsSection(latest)}
    <section class="card">
      <h2>Recent runs</h2>
      ${historyTable(sorted.slice(0, limit))}
    </section>`
    : EMPTY_PAGE_BODY;
  return renderDocument(body, latest?.generatedAt);
}

/** Hours between the newest ingested run and this page being generated. */
const STALE_AFTER_HOURS = 24;

/**
 * Spec 18 — the page states its own staleness. The site is baked into an image
 * and served until the deploy pin moves, so "generated at" alone cannot tell a
 * fresh build from one the fleet stopped updating two days ago.
 */
function stalenessNote(newestRunAt: string | undefined, now: Date): string {
  if (!newestRunAt) return "";
  const age = now.getTime() - new Date(newestRunAt).getTime();
  if (Number.isNaN(age) || age < STALE_AFTER_HOURS * 3_600_000) return "";
  const days = Math.floor(age / 86_400_000);
  const howLong = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : "over a day";
  return ` · <span class="stale">newest run is ${howLong} old (${formatInstant(newestRunAt)}) — this page may be a stale deploy</span>`;
}

function renderDocument(body: string, newestRunAt?: string | undefined): string {
  const now = new Date();
  return `<!doctype html>
<html lang="en" data-theme="dark">
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
      Synthetic data only — no employee PII. Generated ${formatInstant(now.toISOString())} · summary schema v2${stalenessNote(newestRunAt, now)}.
    </footer>
</main>
</body>
</html>
`;
}

const STYLE = `
/* Dark is the default (data-theme="dark" on <html>); light is an explicit opt-in. */
:root {
  --bg: #0f1216; --panel: #171b21; --ink: #e6e9ec; --muted: #9aa4af;
  --border: #262c34; --pass: #4ccb7d; --pass-bg: #12321f; --fail: #f0716f; --fail-bg: #3a1b1b;
  --flake: #e8b04b; --flake-bg: #3a2f13; --never: #c98fe0; --never-bg: #32203a;
}
:root[data-theme="light"] {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24; --muted: #5b6570;
  --border: #e2e6ea; --pass: #1f8a4c; --pass-bg: #e7f6ec; --fail: #c62828; --fail-bg: #fdeaea;
  --flake: #8a5a00; --flake-bg: #fdf3e0; --never: #6b2f86; --never-bg: #f6ecfa;
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
.status.flake { border-left-color: var(--flake); }
.status.skip { border-left-color: var(--muted); }
.status-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.meta, .counts { margin: 8px 0 0; color: var(--muted); }
.counts strong { color: var(--ink); }
.badge { font: 700 0.72rem/1 ui-monospace, monospace; letter-spacing: .04em; padding: 5px 9px;
  border-radius: 999px; white-space: nowrap; }
.badge.pass { color: var(--pass); background: var(--pass-bg); }
.badge.fail { color: var(--fail); background: var(--fail-bg); }
.badge.flake { color: var(--flake); background: var(--flake-bg); }
.badge.never { color: var(--never); background: var(--never-bg); }
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
.bar-fill.flake { background: var(--flake); }
.bar-fill.skip { background: var(--muted); }
.badge.skip { color: var(--muted); background: var(--border); }
.prov { color: var(--muted); font-size: 0.83rem; margin: 0 0 12px; }
.small { font-size: 0.82rem; margin: 6px 0 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.tcard { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--panel); }
.tcard.pass-edge { border-left: 4px solid var(--pass); }
.tcard.fail-edge { border-left: 4px solid var(--fail); }
.tcard.skip-edge { border-left: 4px solid var(--border); }
.tcard.flake-edge { border-left: 4px solid var(--flake); }
.tcard.never-edge { border-left: 4px solid var(--never); background: var(--never-bg); }
.tcard-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tcard h3 { font-size: 0.92rem; margin: 0; line-height: 1.35; }
.checks { list-style: none; margin: 10px 0 0; padding: 0; }
.checks li { display: flex; justify-content: space-between; gap: 10px; align-items: baseline;
  padding: 5px 0; border-top: 1px solid var(--border); font-size: 0.86rem; }
.checks li:first-child { border-top: 0; }
.check-name { color: var(--ink); }
.check-meta { color: var(--muted); white-space: nowrap; }
footer { margin-top: 24px; font-size: 0.82rem; text-align: center; }
.stale { color: var(--flake); }
`;
