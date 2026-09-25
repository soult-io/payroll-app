/**
 * Spec 17 chunk B — pure rendering of the pay-verify dashboard.
 *
 * Takes verify-summary history (newest-first after {@link sortByGeneratedAtDesc})
 * and returns a single self-contained, PII-free HTML document: no external
 * requests, inline CSS, light/dark. No filesystem access lives here — the
 * generator (`generate.ts`) reads/writes and calls {@link renderPage}.
 */

import {
  type Source,
  type Outcome,
  type SuiteKey,
  type SuiteResult,
  type TestResult,
  type TestStatus,
  type VerifySummary,
  JOURNEY_SPEC_FILES,
  outcomeFromTests,
} from "@payroll/verify-summary";
import { escapeHtml } from "./escape.js";
import {
  type EvidenceIndex,
  evidenceFor,
  noMediaNote,
  MEDIA_VIEWER_SCRIPT,
  MEDIA_VIEWER_STYLE,
  mediaViewer,
  type WalkthroughIndex,
  walkthroughFor,
} from "./media.js";

// Shared with media.ts (which lib.ts imports, so it cannot import back);
// re-exported so the package API is unchanged.
export { escapeHtml };

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
 * Clean-pass rate over executed tests, 0–100. A flake is executed but is not a
 * clean pass, so it lowers the bar it sits on.
 *
 * `undefined` when nothing executed — NOT 100. The old 100-for-empty
 * convention predates spec 18 and contradicts it: it labelled a night on which
 * nothing ran "100% pass".
 */
export function passRate(summary: VerifySummary): number | undefined {
  const ran = summary.counts.executed;
  return ran === 0 ? undefined : (summary.counts.passed / ran) * 100;
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
        const key = executionKey(suite.key, test);
        if (isNewer(summary.generatedAt, seen.get(key))) {
          seen.set(key, summary.generatedAt);
        }
      }
    }
  }
  return seen;
}

/**
 * Map key: suite + file + full name.
 *
 * `fullName` alone collides across suites — engine and server can both hold
 * `FUTA credit caps at 5.4%` — and it collides across FILES within one suite
 * too, because vitest's fullName is just the ancestor titles plus the title,
 * with no path. Either collision lets one test's run date vouch for another's
 * never-run test. NUL separates: it cannot occur in a title or a filename.
 */
function executionKey(suiteKey: SuiteKey, test: TestResult): string {
  return `${suiteKey}\u0000${fileKey(test.file)}\u0000${test.fullName}`;
}

/**
 * Basename only. The raw `file` is NOT usable as an identity component across
 * sources: vitest reports an absolute path that differs per runner
 * (`/home/runner/work/...` on GitHub-hosted vs `/__w/...` on the self-hosted
 * qa-e2e box), while Playwright reports a bare `journeys.spec.ts`. The
 * basename is stable in both and is what actually disambiguates.
 */
function fileKey(file: string | undefined): string {
  if (!file) return "";
  return file.split("/").pop() ?? file;
}

/** When this test last executed, per the retained history; undefined = never. */
export function lastExecutionOf(
  suiteKey: SuiteKey,
  test: TestResult,
  lastExecuted: Map<string, string>,
): string | undefined {
  return lastExecuted.get(executionKey(suiteKey, test));
}

export interface Execution {
  test: TestResult;
  source: Source;
  generatedAt: string;
  /** The run that executed it — binds journey evidence to this result (spec 20). */
  runId: string;
  gitSha: string;
}

/**
 * Per (suite, fullName): the most recent run that actually EXECUTED it, and
 * which source that was. Spans every source deliberately — a live-QA-only
 * journey has been proven if the nightly ran it, however many times `ci`
 * skipped it (spec 19).
 */
export function latestExecutions(history: VerifySummary[]): Map<string, Execution> {
  const seen = new Map<string, Execution>();
  for (const summary of history) {
    for (const suite of summary.suites) {
      for (const test of suite.tests) {
        if (test.status === "skipped") continue;
        const key = executionKey(suite.key, test);
        if (isNewer(summary.generatedAt, seen.get(key)?.generatedAt)) {
          seen.set(key, {
            test,
            source: summary.source,
            generatedAt: summary.generatedAt,
            runId: summary.runId,
            gitSha: summary.gitSha,
          });
        }
      }
    }
  }
  return seen;
}

/** A test skipped in this run that no retained run has ever executed. */
function isNeverRun(test: TestResult, lastExecutedAt: string | undefined): boolean {
  return test.status === "skipped" && lastExecutedAt === undefined;
}

function countNeverRun(suite: SuiteResult, lastExecuted: Map<string, string>): number {
  return suite.tests.filter((t) => isNeverRun(t, lastExecutionOf(suite.key, t, lastExecuted)))
    .length;
}

/**
 * A status demoted by tests no retained run has ever executed — one rule, used
 * by both the headline and the suite row so the page cannot contradict itself.
 * A FAILED verdict is never softened.
 */
function demoted(status: Outcome, neverRun: number): { badge: string; cls: string } {
  if (neverRun === 0 || status === "failed") {
    return { badge: badge(status), cls: OUTCOME_CLASS[status] };
  }
  return {
    badge: `<span class="badge flake">${OUTCOME_LABEL[status]} · ${neverRun} NEVER RUN</span>`,
    cls: "flake",
  };
}

/**
 * Parsed instant, or undefined when the string is not a date.
 *
 * Ordering used to be a lexical string compare, which silently assumes every
 * producer emits the same ISO shape in UTC. It does not hold: a `+02:00`
 * offset sorts after an earlier `Z` timestamp, and `…00Z` vs `…00.000Z` order
 * arbitrarily because `'Z' > '.'`. Compare epochs instead.
 */
function instantOf(iso: string): number | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export function sortByGeneratedAtDesc(history: VerifySummary[]): VerifySummary[] {
  // Newest first; an unparseable instant sorts last rather than winning.
  return [...history].sort(
    (a, b) =>
      (instantOf(b.generatedAt) ?? Number.NEGATIVE_INFINITY) -
      (instantOf(a.generatedAt) ?? Number.NEGATIVE_INFINITY),
  );
}

/** Is `candidate` newer than `incumbent`? Unparseable never displaces. */
function isNewer(candidate: string, incumbent: string | undefined): boolean {
  const c = instantOf(candidate);
  if (c === undefined) return false;
  if (incumbent === undefined) return true;
  const i = instantOf(incumbent);
  return i === undefined || c > i;
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

// --- spec 19: the per-source view ----------------------------------------

/**
 * Every source the dashboard expects to hear from. A source is always shown,
 * even with no history at all: an absent card is indistinguishable from a
 * healthy one, which is exactly how a nightly that had been dead for 23 nights
 * managed to look fine.
 */
interface SourceExpectation {
  /** How the source is described on the page. */
  label: string;
  /** What produces it, named so a NEVER REPORTED card is actionable. */
  produces: string;
  /**
   * Silence longer than this is a fault. The thresholds differ because the
   * cadences do: `ci` fires on a push, and a fortnight of quiet is quiet, not
   * broken. `nightly` is a cron — a missed day IS the fault, with one run of
   * slack.
   */
  staleAfterHours: number;
}

const SOURCE_EXPECTATIONS: Record<Source, SourceExpectation> = {
  ci: {
    label: "CI (every push to main)",
    produces: "the `ci` workflow",
    staleAfterHours: 14 * 24,
  },
  nightly: {
    label: "Nightly (live QA)",
    produces: "the `e2e-nightly` workflow, on the self-hosted qa-e2e runner",
    staleAfterHours: 36,
  },
};

/**
 * Derived from SOURCE_EXPECTATIONS, which is a `Record<Source, …>` and so is
 * exhaustiveness-checked by the compiler. Writing the list out by hand would
 * type-check happily while missing a member — and a source with no card is
 * indistinguishable from a healthy one, which is the whole failure this guards.
 */
export const EXPECTED_SOURCES = Object.keys(SOURCE_EXPECTATIONS) as Source[];

export interface SourceView {
  source: Source;
  /** undefined = this source has NEVER reported. */
  latest: VerifySummary | undefined;
  ageHours: number | undefined;
  stale: boolean;
}

/**
 * A source view narrowed to one that has actually reported.
 *
 * `ageHours` is a number here, not optional: a summary only becomes a source's
 * `latest` by way of `isNewer`, which rejects an unparseable instant outright,
 * so a reported view always has a computable age.
 */
export type ReportedSourceView = SourceView & { latest: VerifySummary; ageHours: number };

export function hasReported(view: SourceView): view is ReportedSourceView {
  return view.latest !== undefined && view.ageHours !== undefined;
}

/** The newest summary PER SOURCE, plus how long ago, for every expected source. */
export function sourceViews(history: VerifySummary[], now: Date): SourceView[] {
  const newest = new Map<Source, VerifySummary>();
  for (const s of history) {
    const prev = newest.get(s.source);
    if (isNewer(s.generatedAt, prev?.generatedAt)) newest.set(s.source, s);
  }
  return EXPECTED_SOURCES.map((source) => {
    const latest = newest.get(source);
    if (!latest) return { source, latest: undefined, ageHours: undefined, stale: true };
    const ms = now.getTime() - new Date(latest.generatedAt).getTime();
    const ageHours = Number.isNaN(ms) ? undefined : ms / 3_600_000;
    // FAIL CLOSED. An age we cannot compute, or one in the future (a skewed
    // runner clock), is not evidence of freshness — and treating it as fresh
    // would disable the very quiet-source detection this exists to provide.
    const stale =
      ageHours === undefined ||
      ageHours < 0 ||
      ageHours > SOURCE_EXPECTATIONS[source].staleAfterHours;
    return { source, latest, ageHours, stale };
  });
}

/** Worst-first ranking: a green badge must survive every source, not the best one. */
const OUTCOME_RANK: Record<Outcome, number> = {
  failed: 3,
  not_run: 2,
  passed_with_flakes: 1,
  passed: 0,
};

export function worstOutcome(outcomes: Outcome[]): Outcome {
  let worst: Outcome = "passed";
  for (const o of outcomes) if (OUTCOME_RANK[o] > OUTCOME_RANK[worst]) worst = o;
  return worst;
}

function formatAge(hours: number): string {
  if (hours < 0) return "a negative interval (clock skew)";
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)} days`;
}

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

function suiteRow(suite: SuiteResult, source: Source, lastExecuted: Map<string, string>): string {
  const c = suite.counts;
  return `<tr>
      <td>${escapeHtml(suite.name)}</td>
      <td class="mono">${escapeHtml(source)}</td>
      <td>${demoted(suite.status, countNeverRun(suite, lastExecuted)).badge}</td>
      <td class="num">${c.passed}</td>
      <td class="num">${c.flaky ?? "—"}</td>
      <td class="num">${c.failed}</td>
      <td class="num">${c.skipped}</td>
      <td class="num">${c.total}</td>
      <td class="num">${formatDurationMs(suite.durationMs)}</td>
    </tr>`;
}

function historyRow(summary: VerifySummary): string {
  const rate = passRate(summary);
  // No bar at all for a run that executed nothing — a full-width "100% pass"
  // is the claim spec 18 exists to stop.
  const bar =
    rate === undefined
      ? `<span class="muted">—</span>`
      : `<span class="bar" title="${rate.toFixed(0)}% pass"><span class="bar-fill ${outcomeClass(summary.overallStatus)}" style="width:${rate.toFixed(0)}%"></span></span>`;
  return `<tr>
      <td>${formatInstant(summary.generatedAt)}</td>
      <td>${badge(summary.overallStatus)}</td>
      <td class="mono">${escapeHtml(summary.source)}</td>
      <td class="mono">${escapeHtml(shortSha(summary.gitSha))}</td>
      <td class="num">${summary.counts.passed}/${summary.counts.total}</td>
      <td>${bar}</td>
    </tr>`;
}

function suiteTable(views: SourceView[], lastExecuted: Map<string, string>): string {
  const rows = views
    .flatMap((v) =>
      v.latest ? v.latest.suites.map((s) => suiteRow(s, v.source, lastExecuted)) : [],
    )
    .join("\n");
  return `<div class="table-wrap"><table class="suites">
      <thead><tr><th>Suite</th><th>Source</th><th>Status</th><th>Pass</th><th>Flaky</th><th>Fail</th><th>Skip</th><th>Total</th><th>Duration</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">no suites reported</td></tr>`}</tbody>
    </table></div>`;
}

function historyTable(history: VerifySummary[]): string {
  const rows = history.map(historyRow).join("\n");
  return `<div class="table-wrap"><table class="history">
      <thead><tr><th>Run</th><th>Status</th><th>Source</th><th>Commit</th><th>Passed</th><th>Pass rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/** Worst outcome across every reporting source AND every one of their suites. */
function headlineOutcome(reported: ReportedSourceView[]): Outcome {
  if (reported.length === 0) return "not_run";
  // Per-SUITE statuses as well as each summary's own `overallStatus`. A run can
  // report `passed` overall while one of its suites is `not_run`, and reading
  // only the top-level value let the headline go green above a Suites table
  // saying NOT RUN. It also means a summary whose stored `overallStatus`
  // disagrees with its own suites cannot talk the page into a green badge.
  return worstOutcome([
    ...reported.map((v) => v.latest.overallStatus),
    ...reported.flatMap((v) => v.latest.suites.map((su) => su.status)),
  ]);
}

/**
 * Per-source counts, summed. ci and the nightly both report the e2e suite, so
 * a shared journey counts once per source — the label says so. Taken from each
 * summary's own `counts`, which is authoritative; deriving them from `tests[]`
 * would make the headline depend on that array always being complete, which
 * nothing enforces.
 */
function summedTotals(reported: ReportedSourceView[]): {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  flaky: string;
} {
  const t = reported.reduce(
    (acc, v) => ({
      passed: acc.passed + v.latest.counts.passed,
      failed: acc.failed + v.latest.counts.failed,
      skipped: acc.skipped + v.latest.counts.skipped,
      total: acc.total + v.latest.counts.total,
    }),
    { passed: 0, failed: 0, skipped: 0, total: 0 },
  );
  // Only sum flakes when EVERY reporting source knows its own count; one
  // upgraded v1 summary makes the total unknowable, and a partial number would
  // read as fact (spec 18 §Counts).
  const known = reported.every((v) => v.latest.counts.flaky !== undefined);
  const sum = reported.reduce((n, v) => n + (v.latest.counts.flaky ?? 0), 0);
  return { ...t, flaky: known ? ` <strong>${sum}</strong> flaky ·` : "" };
}

function quietSentence(quiet: SourceView[]): string {
  return quiet
    .map((v) => {
      const meta = SOURCE_EXPECTATIONS[v.source];
      return v.latest
        ? `${escapeHtml(meta.label)} has not reported for ${formatAge(v.ageHours ?? 0)}`
        : `${escapeHtml(meta.label)} has never reported`;
    })
    .join(" · ");
}

function headerCard(
  views: SourceView[],
  reportHref: string | undefined,
  tests: { test: TestResult; neverRun: boolean }[],
): string {
  const neverRun = tests.filter((t) => t.neverRun).length;
  const reported = views.filter(hasReported);
  const quiet = views.filter((v) => v.stale);
  const base = headlineOutcome(reported);
  const totals = summedTotals(reported);

  // Both facts matter, so the badge carries both: a run can be green on what it
  // executed AND have tests nothing has ever proven AND have a source that
  // stopped reporting. Suppressing either is how this page lied before.
  const reasons: string[] = [];
  if (neverRun > 0) reasons.push(`${neverRun} NEVER RUN`);
  if (quiet.length > 0) reasons.push(`${quiet.length} SOURCE${quiet.length > 1 ? "S" : ""} QUIET`);
  const demote = reasons.length > 0 && base !== "failed";

  const report = reportHref
    ? `<a class="report" href="${escapeHtml(reportHref)}">View full test report →</a>`
    : "";
  const neverLine =
    neverRun > 0
      ? `<p class="small stale"><strong>${neverRun}</strong> distinct test${neverRun === 1 ? "" : "s"} no retained run has ever executed.</p>`
      : "";
  const quietText = quietSentence(quiet);
  return `<section class="card status ${demote ? "flake" : outcomeClass(base)}">
      <div class="status-head">
        <h1>payroll-app — QA verification</h1>
        ${demote ? `<span class="badge flake">${[OUTCOME_LABEL[base], ...reasons].join(" · ")}</span>` : badge(base)}
      </div>
      <p class="counts">
        <strong>${totals.passed}</strong> passed ·${totals.flaky} <strong>${totals.failed}</strong> failed ·
        <strong>${totals.skipped}</strong> skipped · ${totals.total} total
        <span class="muted">summed across ${reported.length} source${reported.length === 1 ? "" : "s"}${reported.length > 1 ? ", so shared journeys count once per source" : ""}</span>
      </p>
      ${neverLine}
      ${quietText ? `<p class="small stale">${quietText}</p>` : ""}
      ${report}
    </section>`;
}

/**
 * Every DISTINCT test the system currently has, across all reporting sources.
 *
 * Deduped by (suite, file, fullName), because ci and the nightly both report
 * the e2e suite. This is the set the headline's never-run figure is computed
 * over, and it spans ALL suites, not just the e2e journeys: narrowing it to
 * journeys let a never-run unit test demote its suite row while the headline
 * stayed green — the page contradicting itself one line apart.
 */
function systemTests(
  views: SourceView[],
  executions: Map<string, Execution>,
): { key: string; suiteKey: SuiteKey; test: TestResult; neverRun: boolean }[] {
  const byKey = new Map<string, { key: string; suiteKey: SuiteKey; test: TestResult }>();
  for (const v of views) {
    if (!hasReported(v)) continue;
    for (const suite of v.latest.suites) {
      for (const test of suite.tests) {
        const key = executionKey(suite.key, test);
        const prev = byKey.get(key);
        // A test executed by ANY source represents the pair; a skip only wins
        // if nothing better has been seen.
        if (prev === undefined || (prev.test.status === "skipped" && test.status !== "skipped")) {
          byKey.set(key, { key, suiteKey: suite.key, test });
        }
      }
    }
  }
  return [...byKey.values()].map((e) => ({
    ...e,
    neverRun: isNeverRun(e.test, executions.get(e.key)?.generatedAt),
  }));
}

function sourceCard(view: SourceView): string {
  const meta = SOURCE_EXPECTATIONS[view.source];
  if (!hasReported(view)) {
    return `<article class="tcard never-edge">
      <div class="tcard-head"><h3>${escapeHtml(meta.label)}</h3><span class="badge never">NEVER REPORTED</span></div>
      <p class="muted small">No usable summary from this source has ever been ingested. It should come from ${escapeHtml(meta.produces)}.</p>
    </article>`;
  }
  const c = view.latest.counts;
  const flaky = c.flaky === undefined ? "" : ` · ${c.flaky} flaky`;
  const freshness = view.stale
    ? `<p class="small stale">Last reported ${formatAge(view.ageHours)} ago — expected at most ${formatAge(meta.staleAfterHours)}.</p>`
    : `<p class="muted small">Last reported ${formatAge(view.ageHours)} ago.</p>`;
  return `<article class="tcard ${view.stale ? "flake" : outcomeClass(view.latest.overallStatus)}-edge">
      <div class="tcard-head"><h3>${escapeHtml(meta.label)}</h3>${badge(view.latest.overallStatus)}</div>
      <p class="muted small">
        ${c.passed} passed · ${c.failed} failed${flaky} · ${c.skipped} skipped · ${c.total} total
      </p>
      <p class="muted small">
        <span class="mono">${escapeHtml(shortSha(view.latest.gitSha))}</span> ·
        ${formatInstant(view.latest.generatedAt)}
      </p>
      ${freshness}
    </article>`;
}

function sourcesSection(views: SourceView[]): string {
  return `<section class="card">
      <h2>Sources</h2>
      <p class="prov">Each source runs a different suite: CI covers the engine, server and the ephemeral end-to-end journeys; the nightly covers the live-QA journeys only. Both must be reporting for this page to mean anything.</p>
      <div class="cards">${views.map(sourceCard).join("\n")}</div>
    </section>`;
}

// --- chunk C: rich cards (per-journey e2e + tax-worksheet correctness) ----

// Records, like OUTCOME_* above: a new TestStatus becomes a compile error
// rather than silently taking a default arm.
const TEST_CLASS: Record<TestStatus, string> = {
  passed: "pass",
  failed: "fail",
  flaky: "flake",
  skipped: "skip",
};

const TEST_LABEL: Record<TestStatus, string> = {
  passed: "PASS",
  failed: "FAIL",
  flaky: "FLAKY",
  skipped: "SKIP",
};

function testBadge(status: TestStatus): string {
  return `<span class="badge ${TEST_CLASS[status]}">${TEST_LABEL[status]}</span>`;
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

// One implementation of the spec-18 outcome table, shared with the aggregator.
const groupOutcome = outcomeFromTests;

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
 * last ran or that it never has. Takes the resolved instant rather than the
 * map, so "is this never-run" is decided once, by the caller.
 */
function journeyDetail(test: TestResult, lastExecutedAt: string | undefined): string {
  const reason = test.skipReason ? escapeHtml(test.skipReason) : "no reason recorded by the suite";
  const why = test.firstFailure ? ` · first attempt: ${escapeHtml(test.firstFailure)}` : "";
  if (test.status === "skipped") {
    if (lastExecutedAt === undefined) {
      return `<p class="muted small">Never executed in any retained run — ${reason}</p>`;
    }
    return `<p class="muted small">${reason} · last ran ${formatInstant(lastExecutedAt)}</p>`;
  }
  if (test.status === "flaky") {
    const tries = test.attempts ? `${test.attempts} attempts` : "passed on retry";
    return `<p class="muted small">${formatDurationMs(test.durationMs)} · ${tries}${why}</p>`;
  }
  // A failure carries its reason too — the evidence is collected either way,
  // and suppressing it on the one status that most needs it made no sense.
  return `<p class="muted small">${formatDurationMs(test.durationMs)}${why}</p>`;
}

/**
 * Did any source's LATEST run actually execute this journey? That is the
 * difference between "green now" and "green once". A journey every source is
 * currently skipping keeps a SKIP chip and states its last real result — it
 * must not wear a pass it earned days ago.
 */
function executedInLatest(views: SourceView[], test: TestResult): boolean {
  // Scoped to the e2e suite, because the execution lookup is keyed that way.
  // `fullName` alone collides across suites (see executionKey), and a collision
  // here would let a unit test vouch for a journey's freshness.
  return views.some((v) =>
    v.latest?.suites.some(
      (s) =>
        s.key === "e2e" &&
        s.tests.some((t) => t.fullName === test.fullName && t.status !== "skipped"),
    ),
  );
}

/** Everything a journey card's media needs from the render options. */
interface MediaContext {
  evidence: EvidenceIndex | undefined;
  walkthrough: WalkthroughIndex | undefined;
  runUrlBase: string | undefined;
}

/**
 * Screens for a card whose result is current, from the evidence bundle bound
 * to that exact run (spec 20). A result from any other run gets a note, never
 * another run's screens.
 */
function journeyMedia(
  shown: TestResult,
  execution: Execution | undefined,
  current: boolean,
  { evidence, walkthrough, runUrlBase }: MediaContext,
): string {
  if (!current || !execution) return "";
  // Utility specs (spec 20 D4) never carry evidence: no media line at all,
  // rather than a "no evidence" note that suggests something went missing.
  if (!JOURNEY_SPEC_FILES.has(fileKey(shown.file))) return "";
  const journey = evidenceFor(evidence, execution, shown.fullName);
  if (!journey || !evidence) return noMediaNote(execution);
  const video = walkthroughFor(walkthrough, evidence, shown.fullName, journey);
  return mediaViewer(journey, shown.status, execution.runId, video, runUrlBase);
}

function journeyCard(
  test: TestResult,
  execution: Execution | undefined,
  current: boolean,
  media: MediaContext,
): string {
  const never = execution === undefined && test.status === "skipped";
  if (never) {
    return `<article class="tcard never-edge">
      <div class="tcard-head"><h3>${escapeHtml(test.name)}</h3><span class="badge never">NEVER RUN</span></div>
      ${journeyDetail(test, undefined)}
    </article>`;
  }
  // Current: show what the latest run said, attributed to its source.
  // Not current: SKIP, plus the last real result so the reader sees both that
  // it is not running now AND how it last went.
  const shown = current ? (execution?.test ?? test) : test;
  const edge = current ? TEST_CLASS[shown.status] : "skip";
  const chip = current ? testBadge(shown.status) : testBadge("skipped");
  const attribution = execution
    ? `<p class="muted small">${current ? "" : `last ran ${testBadge(execution.test.status)} · `}${escapeHtml(execution.source)} · ${formatInstant(execution.generatedAt)}</p>`
    : "";
  return `<article class="tcard ${edge}-edge">
      <div class="tcard-head"><h3>${escapeHtml(test.name)}</h3>${chip}</div>
      ${journeyDetail(shown, execution?.generatedAt)}
      ${attribution}
      ${journeyMedia(shown, execution, current, media)}
    </article>`;
}

/**
 * Harness self-tests of the e2e tooling (spec 20's still capture and evidence
 * reporter), grouped under a `harness · …` describe. They run in the e2e suite
 * and count there, but they are not product journeys, so they get no card.
 */
export function isHarnessTest(test: TestResult): boolean {
  return /(^|\s)harness · /.test(test.fullName);
}

/**
 * Every e2e test any source most recently reported, deduped by full name.
 * Sources run different subsets, so the union — not one source's list — is the
 * set of journeys this product actually has.
 */
function journeyUnion(views: SourceView[]): TestResult[] {
  const byName = new Map<string, TestResult>();
  for (const v of views) {
    const e2e = v.latest?.suites.find((s) => s.key === "e2e");
    for (const t of e2e?.tests ?? []) {
      if (!isHarnessTest(t) && !byName.has(t.fullName)) byName.set(t.fullName, t);
    }
  }
  return [...byName.values()];
}

function journeyCardsSection(
  views: SourceView[],
  executions: Map<string, Execution>,
  media: MediaContext,
): string {
  const tests = journeyUnion(views);
  if (tests.length === 0) return "";
  const cards = tests
    .map((t) =>
      journeyCard(t, executions.get(executionKey("e2e", t)), executedInLatest(views, t), media),
    )
    .join("\n");
  const runs = views
    .filter(hasReported)
    .map((v) => `${escapeHtml(v.source)} ${escapeHtml(shortSha(v.latest.gitSha))}`)
    .join(" · ");
  return `<section class="card">
      <h2>End-to-end journeys</h2>
      <p class="prov">Every journey either source reports, showing the most recent run that actually executed it. Runs: ${runs}.</p>
      <div class="cards">${cards}</div>
    </section>`;
}

const EMPTY_PAGE_BODY = `<section class="card status skip">
      <div class="status-head"><h1>payroll-app — QA verification</h1></div>
      <p class="muted">No verification runs ingested yet. The dashboard populates after the first CI or nightly run publishes a summary.</p>
    </section>`;

export interface RenderOptions {
  /** Relative href to the copied Playwright html report, when present. */
  reportHref?: string | undefined;
  /** Max history rows to render (default 30). */
  historyLimit?: number | undefined;
  /** History files the generator could not parse — surfaced in the footer. */
  skippedSummaries?: number | undefined;
  /** Clock override, so staleness is testable. Defaults to the real now. */
  now?: Date | undefined;
  /** The validated, copied journey-evidence bundle (spec 20), when there is one. */
  evidence?: EvidenceIndex | undefined;
  /** The validated, copied walkthrough bundle (spec 20), when there is one. */
  walkthrough?: WalkthroughIndex | undefined;
  /** Base URL a GitHub Actions run id is appended to, for run links. */
  runUrlBase?: string | undefined;
}

/** Render the full dashboard document from the ingested history. */
export function renderPage(history: VerifySummary[], options: RenderOptions = {}): string {
  const now = options.now ?? new Date();
  const sorted = sortByGeneratedAtDesc(history);
  const limit = options.historyLimit ?? 30;
  const views = sourceViews(sorted, now);
  const executions = latestExecutions(sorted);
  const lastExecuted = lastExecutedAtByTest(sorted);
  const tests = systemTests(views, executions);
  // Tax cards come from whichever source carries the non-e2e suites (ci); a
  // nightly-only page would otherwise silently drop them.
  const taxSource = views.find((v) => v.latest?.suites.some((s) => s.key !== "e2e"))?.latest;
  const body =
    sorted.length > 0
      ? `${headerCard(views, options.reportHref, tests)}
    ${sourcesSection(views)}
    <section class="card">
      <h2>Suites</h2>
      ${suiteTable(views, lastExecuted)}
    </section>
    ${journeyCardsSection(views, executions, {
      evidence: options.evidence,
      walkthrough: options.walkthrough,
      runUrlBase: options.runUrlBase,
    })}
    ${taxSource ? taxCardsSection(taxSource) : ""}
    <section class="card">
      <h2>Recent runs</h2>
      ${historyTable(sorted.slice(0, limit))}
    </section>`
      : EMPTY_PAGE_BODY;
  return renderDocument(body, sorted[0]?.generatedAt, options.skippedSummaries ?? 0, now);
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

function renderDocument(
  body: string,
  newestRunAt: string | undefined,
  skippedSummaries: number,
  now: Date,
): string {
  // A run the generator could not parse otherwise disappears from the page
  // with no signal at all — the warning only reaches the CI log.
  const dropped =
    skippedSummaries > 0
      ? ` · <span class="stale">${skippedSummaries} summary file(s) skipped as unreadable</span>`
      : "";
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
      Synthetic data only — no employee PII. Generated ${formatInstant(now.toISOString())} · summary schema v2${stalenessNote(newestRunAt, now)}${dropped}.
    </footer>
</main>
<script>${MEDIA_VIEWER_SCRIPT}</script>
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
/* Tables scroll inside their own box on a phone; the page never scrolls sideways. */
.table-wrap { overflow-x: auto; }
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
${MEDIA_VIEWER_STYLE}`;
