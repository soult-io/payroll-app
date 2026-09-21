/**
 * Spec 17 §1 — pure transforms from the suites' own reporter JSON into the
 * canonical {@link VerifySummary}. No filesystem or process access lives here;
 * the CLI (`cli.ts`) does the IO and calls these.
 */

import { z } from "zod";
import {
  type Counts,
  type Outcome,
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

const pwResultSchema = z.object({
  status: z.string().optional(),
  duration: z.number().optional(),
});
const pwTestSchema = z.object({
  status: z.string().optional(),
  results: z.array(pwResultSchema).default([]),
});
const pwSpecSchema = z.object({
  title: z.string().optional(),
  file: z.string().optional(),
  ok: z.boolean().optional(),
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

/**
 * playwright spec status, aggregated over its per-project test entries.
 * `flaky` (passed on retry) is treated as passed — it falls through the
 * failed/skipped checks to the final `return "passed"`.
 */
function playwrightSpecStatus(tests: z.infer<typeof pwTestSchema>[]): TestStatus {
  if (tests.length === 0) return "skipped";
  if (tests.some((t) => t.status === "unexpected" || t.status === "timedOut")) return "failed";
  if (tests.every((t) => t.status === "skipped")) return "skipped";
  return "passed";
}

function playwrightSpecDurationMs(tests: z.infer<typeof pwTestSchema>[]): number {
  let total = 0;
  for (const t of tests) {
    for (const r of t.results) total += r.duration ?? 0;
  }
  return total;
}

// --- assembly helpers ----------------------------------------------------

function makeTest(
  name: string,
  fullName: string,
  status: TestStatus,
  durationMs: number,
  file: string | undefined,
): TestResult {
  return { name, fullName, status, durationMs, ...(file ? { file } : {}) };
}

function countTests(tests: TestResult[]): Counts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.status === "passed") passed += 1;
    else if (t.status === "failed") failed += 1;
    else skipped += 1;
  }
  return { passed, failed, skipped, total: tests.length };
}

/** Binary outcome: any failure fails; skipped-only or empty passes. */
function outcomeFromCounts(counts: Counts): Outcome {
  return counts.failed > 0 ? "failed" : "passed";
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
          playwrightSpecStatus(spec.tests),
          playwrightSpecDurationMs(spec.tests),
          spec.file ?? suite.file,
        ),
      );
    }
    for (const child of suite.suites) walk(child, path);
  };
  for (const suite of report.suites) walk(suite, []);
  return suiteFromTests(meta.key, meta.name, tests);
}

function sumCounts(suites: SuiteResult[]): Counts {
  const acc: Counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const s of suites) {
    acc.passed += s.counts.passed;
    acc.failed += s.counts.failed;
    acc.skipped += s.counts.skipped;
    acc.total += s.counts.total;
  }
  return acc;
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
  const overallStatus: Outcome = anySuiteFailed || missingRequired ? "failed" : "passed";
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
