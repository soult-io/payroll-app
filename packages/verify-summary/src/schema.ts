/**
 * Spec 18 §"Schema v2" — the versioned QA result summary.
 *
 * This is the contract between the test suites (producers) and the pay-verify
 * site (consumer). It must stay backward-compatible within a `schemaVersion`;
 * a breaking field change bumps the version. v1 files are still readable —
 * see `migrate.ts`.
 *
 * v2 exists because v1 could not express two true states, and so reported them
 * as green: a test that only passed on retry, and a suite in which nothing ran.
 */

import { z } from "zod";

/** Bumped on any breaking change to the summary shape. */
export const SCHEMA_VERSION = 2 as const;

/**
 * `flaky` = ultimately passed, but an earlier attempt failed, timed out or was
 * interrupted. It is its own bucket: it never merges into passed or failed.
 */
export const testStatusSchema = z.enum(["passed", "failed", "flaky", "skipped"]);
export type TestStatus = z.infer<typeof testStatusSchema>;

/**
 * `not_run` is deliberately not `passed` — a suite that executed nothing has
 * proven nothing. `passed_with_flakes` is deliberately not `passed` either.
 */
export const outcomeSchema = z.enum(["passed", "passed_with_flakes", "failed", "not_run"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const suiteKeySchema = z.enum(["engine", "server", "e2e"]);
export type SuiteKey = z.infer<typeof suiteKeySchema>;

export const sourceSchema = z.enum(["ci", "nightly"]);
export type Source = z.infer<typeof sourceSchema>;

export const countsSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /**
   * Absent means UNKNOWN, not zero — that is the honest value for a v1 summary
   * upgraded forward, since v1 counted flakes as passes and the split is not
   * recoverable. Consumers must render nothing rather than `0` when absent.
   */
  flaky: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative(),
  /** passed + failed + flaky. Always derivable, so always present. */
  executed: z.number().int().nonnegative(),
  /** Every test the reporter emitted, skips included. */
  total: z.number().int().nonnegative(),
});
export type Counts = z.infer<typeof countsSchema>;

/** First line of a failure message, capped so no codeframe ever ships. */
export const FIRST_FAILURE_MAX_CHARS = 200;

export const testResultSchema = z.object({
  /** The leaf test title. */
  name: z.string(),
  /** Full ancestor path + title, e.g. "940 worksheet zero credit -> 6.0% net". */
  fullName: z.string(),
  status: testStatusSchema,
  durationMs: z.number().nonnegative(),
  /** Source file, when the reporter provides one. */
  file: z.string().optional(),
  /** Reporter result entries for this test; 1 for a clean pass. */
  attempts: z.number().int().positive().optional(),
  /** Why the first failing attempt failed - answers "flaky how?". */
  firstFailure: z.string().max(FIRST_FAILURE_MAX_CHARS).optional(),
  /** The stated reason a skipped test was skipped, when the suite gives one. */
  skipReason: z.string().optional(),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const suiteResultSchema = z.object({
  key: suiteKeySchema,
  name: z.string(),
  status: outcomeSchema,
  durationMs: z.number().nonnegative(),
  counts: countsSchema,
  tests: z.array(testResultSchema),
});
export type SuiteResult = z.infer<typeof suiteResultSchema>;

export const verifySummarySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string(),
  source: sourceSchema,
  gitSha: z.string(),
  gitRef: z.string(),
  /** ISO-8601 UTC instant the summary was assembled. */
  generatedAt: z.string(),
  overallStatus: outcomeSchema,
  counts: countsSchema,
  suites: z.array(suiteResultSchema),
});
export type VerifySummary = z.infer<typeof verifySummarySchema>;
