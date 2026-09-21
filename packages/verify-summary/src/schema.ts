/**
 * Spec 17 §1.2 — the versioned QA result summary.
 *
 * This is the contract between the test suites (producers) and the pay-verify
 * site (consumer, chunk B). It must stay backward-compatible within a
 * `schemaVersion`; a breaking field change bumps the version.
 */

import { z } from "zod";

/** Bumped on any breaking change to the summary shape. */
export const SCHEMA_VERSION = 1 as const;

export const testStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type TestStatus = z.infer<typeof testStatusSchema>;

/** A suite/run is binary: skipped-only or empty counts as passed. */
export const outcomeSchema = z.enum(["passed", "failed"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const suiteKeySchema = z.enum(["engine", "server", "e2e"]);
export type SuiteKey = z.infer<typeof suiteKeySchema>;

export const sourceSchema = z.enum(["ci", "nightly"]);
export type Source = z.infer<typeof sourceSchema>;

export const countsSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type Counts = z.infer<typeof countsSchema>;

export const testResultSchema = z.object({
  /** The leaf test title. */
  name: z.string(),
  /** Full ancestor path + title, e.g. "940 worksheet zero credit → 6.0% net". */
  fullName: z.string(),
  status: testStatusSchema,
  durationMs: z.number().nonnegative(),
  /** Source file, when the reporter provides one. */
  file: z.string().optional(),
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
