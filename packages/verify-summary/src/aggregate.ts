/**
 * Spec 17 §1 — pure transforms from the suites' own reporter JSON into the
 * canonical {@link VerifySummary}. No filesystem or process access lives here;
 * the CLI (`cli.ts`) does the IO and calls these.
 */

import { z } from "zod";
import {
  type Counts,
  type Outcome,
  FIRST_FAILURE_MAX_CHARS,
  SCHEMA_VERSION,
  type SuiteKey,
  type SuiteResult,
  type Source,
  type TestResult,
  type TestStatus,
  type VerifySummary,
} from "./schema.js";

// --- vitest json reporter (jest-compatible shape) ------------------------

const vitestAssertionSchema = z.object({
  title: z.string(),
  fullName: z.string().optional(),
  ancestorTitles: z.array(z.string()).optional(),
  status: z.string(),
  duration: z.number().nullable().optional(),
});
const vitestFileSchema = z.object({
  name: z.string().optional(),
  assertionResults: z.array(vitestAssertionSchema).default([]),
});
const vitestReportSchema = z.object({
  testResults: z.array(vitestFileSchema).default([]),
});

// --- playwright json reporter (recursive suites) -------------------------

const pwErrorSchema = z.object({ message: z.string().optional() });
const pwResultSchema = z.object({
  status: z.string().optional(),
  duration: z.number().optional(),
  errors: z.array(pwErrorSchema).default([]),
});
const pwAnnotationSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
});
const pwTestSchema = z.object({
  status: z.string().optional(),
  annotations: z.array(pwAnnotationSchema).default([]),
  results: z.array(pwResultSchema).default([]),
});
const pwSpecSchema = z.object({
  title: z.string().optional(),
  file: z.string().optional(),
  ok: z.boolean().optional(),
  annotations: z.array(pwAnnotationSchema).default([]),
  tests: z.array(pwTestSchema).default([]),
});
type PwSuite = {
  title?: string | undefined;
  file?: string | undefined;
  specs: z.infer<typeof pwSpecSchema>[];
  suites: PwSuite[];
};
const pwSuiteSchema: z.ZodType<PwSuite> = z.lazy(() =>
  z.object({
    title: z.string().optional(),
    file: z.string().optional(),
    specs: z.array(pwSpecSchema).default([]),
    suites: z.array(pwSuiteSchema).default([]),
  }),
);
const playwrightReportSchema = z.object({
  suites: z.array(pwSuiteSchema).default([]),
});

// --- status mapping ------------------------------------------------------

/** vitest assertion status → our tri-state (pending/todo/etc. → skipped). */
function vitestStatus(raw: string): TestStatus {
  if (raw === "passed") return "passed";
  if (raw === "failed") return "failed";
  return "skipped";
}

/** A reporter result entry that did not succeed and was not a deliberate skip. */
function isFailedAttempt(result: z.infer<typeof pwResultSchema>): boolean {
  return result.status !== undefined && result.status !== "passed" && result.status !== "skipped";
}

/**
 * Verdict derived from the attempts alone. Used when the reporter's own
 * test-level status is missing or unrecognized — the fallback must FAIL
 * CLOSED, because a green fall-through is the exact defect spec 18 removes.
 */
function statusFromResults(test: z.infer<typeof pwTestSchema>): TestStatus {
  const results = test.results;
  const last = results[results.length - 1];
  if (!last) return "skipped";
  if (last.status === "skipped") return "skipped";
  if (last.status !== "passed") return "failed";
  return results.slice(0, -1).some(isFailedAttempt) ? "flaky" : "passed";
}

/**
 * One project entry's verdict. Playwright's test-level status is one of
 * `expected | unexpected | flaky | skipped`; anything else routes to
 * {@link statusFromResults} rather than defaulting to a pass.
 *
 * `expected` is still checked against its own attempts: a report produced with
 * `retries: 0` records the retried attempts without ever labelling them flaky.
 */
function playwrightTestStatus(test: z.infer<typeof pwTestSchema>): TestStatus {
  switch (test.status) {
    case "unexpected":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    case "expected": {
      const derived = statusFromResults(test);
      return derived === "passed" ? "passed" : derived;
    }
    default:
      return statusFromResults(test);
  }
}

/**
 * playwright spec status, aggregated over its per-project test entries.
 * Order matters: a real failure outranks a flake, which outranks a pass.
 *
 * `spec.ok` is Playwright's own verdict for the spec and is used as a FLOOR:
 * it can turn a computed pass into a failure, never the other way round, and
 * it never touches a skip (Playwright reports `ok: false` for those too).
 */
function playwrightSpecStatus(spec: z.infer<typeof pwSpecSchema>): TestStatus {
  const tests = spec.tests;
  if (tests.length === 0) return "skipped";
  const statuses = tests.map(playwrightTestStatus);
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((st) => st === "skipped")) return "skipped";
  if (statuses.includes("flaky")) return "flaky";
  return spec.ok === false ? "failed" : "passed";
}

/** Attempts across the spec's project entries — the worst (most retried) one. */
function playwrightAttempts(tests: z.infer<typeof pwTestSchema>[]): number | undefined {
  let max = 0;
  for (const t of tests) max = Math.max(max, t.results.length);
  return max > 0 ? max : undefined;
}

/**
 * Truncate by code POINT, not code unit, so the cap can never bisect a
 * surrogate pair and emit a lone surrogate (the repo has a standing rule about
 * byte/char bound miscounting).
 */
function capChars(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

// Built rather than written as a literal: the pattern needs ESC, and a control
// character inside a regex literal is (rightly) a lint error everywhere else.
const ANSI_SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

/**
 * First line of the first failing attempt's error, capped. Playwright messages
 * carry ANSI colour and a multi-line codeframe; neither belongs on a dashboard.
 */
function playwrightFirstFailure(tests: z.infer<typeof pwTestSchema>[]): string | undefined {
  for (const t of tests) {
    for (const r of t.results) {
      if (!isFailedAttempt(r)) continue;
      const raw = r.errors.find((e) => e.message)?.message;
      if (!raw) continue;
      const line = raw.replace(ANSI_SGR, "").split("\n")[0]?.trim();
      if (line) return capChars(line, FIRST_FAILURE_MAX_CHARS);
    }
  }
  return undefined;
}

/** The stated reason for a skip, from the test's (or spec's) skip annotation. */
function playwrightSkipReason(spec: z.infer<typeof pwSpecSchema>): string | undefined {
  const all = [...spec.tests.flatMap((t) => t.annotations), ...spec.annotations];
  return all.find((a) => a.type === "skip" && a.description)?.description;
}

function playwrightSpecDurationMs(tests: z.infer<typeof pwTestSchema>[]): number {
  let total = 0;
  for (const t of tests) {
    for (const r of t.results) total += r.duration ?? 0;
  }
  return total;
}

// --- assembly helpers ----------------------------------------------------

interface TestExtras {
  attempts?: number | undefined;
  firstFailure?: string | undefined;
  skipReason?: string | undefined;
}

function makeTest(
  name: string,
  fullName: string,
  status: TestStatus,
  durationMs: number,
  file: string | undefined,
  extras: TestExtras = {},
): TestResult {
  return {
    name,
    fullName,
    status,
    durationMs,
    ...(file ? { file } : {}),
    ...(extras.attempts !== undefined ? { attempts: extras.attempts } : {}),
    ...(extras.firstFailure !== undefined ? { firstFailure: extras.firstFailure } : {}),
    ...(extras.skipReason !== undefined ? { skipReason: extras.skipReason } : {}),
  };
}

function countTests(tests: TestResult[]): Counts {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.status === "passed") passed += 1;
    else if (t.status === "failed") failed += 1;
    else if (t.status === "flaky") flaky += 1;
    else skipped += 1;
  }
  return { passed, failed, flaky, skipped, executed: passed + failed + flaky, total: tests.length };
}

/**
 * Spec 18: checked in order — a failure outranks everything; a run that
 * executed nothing is `not_run` and NOT `passed` (it proved nothing); a flake
 * demotes an otherwise-green run.
 */
export function outcomeFromCounts(counts: Counts): Outcome {
  if (counts.failed > 0) return "failed";
  if (counts.executed === 0) return "not_run";
  if ((counts.flaky ?? 0) > 0) return "passed_with_flakes";
  return "passed";
}

/** The spec-18 outcome table applied straight to a list of tests. */
export function outcomeFromTests(tests: TestResult[]): Outcome {
  return outcomeFromCounts(countTests(tests));
}

function suiteFromTests(key: SuiteKey, name: string, tests: TestResult[]): SuiteResult {
  const counts = countTests(tests);
  const durationMs = tests.reduce((sum, t) => sum + t.durationMs, 0);
  return { key, name, status: outcomeFromCounts(counts), durationMs, counts, tests };
}

// --- public API ----------------------------------------------------------

export interface SuiteMeta {
  key: SuiteKey;
  name: string;
}

/** Normalize a vitest json report into one suite. */
export function fromVitestReport(raw: unknown, meta: SuiteMeta): SuiteResult {
  const report = vitestReportSchema.parse(raw);
  const tests: TestResult[] = [];
  for (const file of report.testResults) {
    for (const a of file.assertionResults) {
      const fullName = a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(" ");
      tests.push(makeTest(a.title, fullName, vitestStatus(a.status), a.duration ?? 0, file.name));
    }
  }
  return suiteFromTests(meta.key, meta.name, tests);
}

/** Normalize a playwright json report into one suite. */
export function fromPlaywrightReport(raw: unknown, meta: SuiteMeta): SuiteResult {
  const report = playwrightReportSchema.parse(raw);
  const tests: TestResult[] = [];
  const walk = (suite: PwSuite, ancestors: string[]): void => {
    const path = suite.title ? [...ancestors, suite.title] : ancestors;
    for (const spec of suite.specs) {
      const title = spec.title ?? "(untitled)";
      const fullName = [...path, title].join(" ");
      tests.push(
        makeTest(
          title,
          fullName,
          playwrightSpecStatus(spec),
          playwrightSpecDurationMs(spec.tests),
          spec.file ?? suite.file,
          {
            attempts: playwrightAttempts(spec.tests),
            firstFailure: playwrightFirstFailure(spec.tests),
            skipReason: playwrightSkipReason(spec),
          },
        ),
      );
    }
    for (const child of suite.suites) walk(child, path);
  };
  for (const suite of report.suites) walk(suite, []);
  return suiteFromTests(meta.key, meta.name, tests);
}

/**
 * `flaky` stays ABSENT unless EVERY contributing suite reported one. An
 * upgraded v1 suite genuinely does not know its flake count, and a total that
 * silently omits the unknown part would be rendered as fact — so unknown is
 * contagious, not absorbed.
 */
function sumCounts(suites: SuiteResult[]): Counts {
  const acc: Counts = { passed: 0, failed: 0, skipped: 0, executed: 0, total: 0 };
  let flaky = 0;
  let flakyKnown = true;
  for (const s of suites) {
    acc.passed += s.counts.passed;
    acc.failed += s.counts.failed;
    acc.skipped += s.counts.skipped;
    acc.executed += s.counts.executed;
    acc.total += s.counts.total;
    if (s.counts.flaky === undefined) flakyKnown = false;
    else flaky += s.counts.flaky;
  }
  return flakyKnown ? { ...acc, flaky } : acc;
}

export interface SummaryMeta {
  runId: string;
  source: Source;
  gitSha: string;
  gitRef: string;
  generatedAt: string;
  /** Suites that MUST be present; a missing one fails the overall status. */
  requiredSuiteKeys?: SuiteKey[];
}

/** Assemble the final summary and compute the overall status. */
export function buildSummary(suites: SuiteResult[], meta: SummaryMeta): VerifySummary {
  const counts = sumCounts(suites);
  const present = new Set(suites.map((s) => s.key));
  const missingRequired = (meta.requiredSuiteKeys ?? []).some((k) => !present.has(k));
  const anySuiteFailed = suites.some((s) => s.status === "failed");
  const overallStatus: Outcome =
    anySuiteFailed || missingRequired ? "failed" : outcomeFromCounts(counts);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: meta.runId,
    source: meta.source,
    gitSha: meta.gitSha,
    gitRef: meta.gitRef,
    generatedAt: meta.generatedAt,
    overallStatus,
    counts,
    suites,
  };
}
