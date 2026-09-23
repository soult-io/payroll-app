/**
 * Spec 18 §"Back-compat" — read a summary of any known version.
 *
 * The retained history window on the `pay-verify-data` branch is entirely v1
 * and must keep rendering, so the site never parses `verifySummarySchema`
 * directly: it calls {@link parseSummary}, which accepts either version and
 * always hands back v2.
 */

import { z } from "zod";
import {
  type Counts,
  SCHEMA_VERSION,
  type SuiteResult,
  type VerifySummary,
  verifySummarySchema,
} from "./schema.js";

// --- the v1 shape, frozen ------------------------------------------------
// Every enum is spelled out here rather than imported from v2, so that adding
// a suite key or a source to v2 cannot silently change what "a v1 file" means.
// This duplication is the point of a migration boundary; it is not drift.

const v1CountsSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** v1 had no `flaky` test status and no `not_run`/`passed_with_flakes` outcome. */
const v1TestStatusSchema = z.enum(["passed", "failed", "skipped"]);
const v1OutcomeSchema = z.enum(["passed", "failed"]);
const v1SuiteKeySchema = z.enum(["engine", "server", "e2e"]);
const v1SourceSchema = z.enum(["ci", "nightly"]);

const v1TestSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  status: v1TestStatusSchema,
  durationMs: z.number().nonnegative(),
  file: z.string().optional(),
});

const v1SuiteSchema = z.object({
  key: v1SuiteKeySchema,
  name: z.string(),
  status: v1OutcomeSchema,
  durationMs: z.number().nonnegative(),
  counts: v1CountsSchema,
  tests: z.array(v1TestSchema),
});

export const verifySummaryV1Schema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  source: v1SourceSchema,
  gitSha: z.string(),
  gitRef: z.string(),
  generatedAt: z.string(),
  overallStatus: v1OutcomeSchema,
  counts: v1CountsSchema,
  suites: z.array(v1SuiteSchema),
});
export type VerifySummaryV1 = z.infer<typeof verifySummaryV1Schema>;

// --- upgrade -------------------------------------------------------------

/**
 * `flaky` is left ABSENT, not zeroed. v1 counted a retry-pass as a pass, so the
 * split is not recoverable from the file; absent reads as "unknown", which is
 * true, whereas `0` would be a claim the data does not support.
 *
 * `executed` = passed + failed, which is right either way: a v1 flake sat in
 * `passed` and was executed regardless.
 */
export function upgradeV1(v1: VerifySummaryV1): VerifySummary {
  const counts = (c: z.infer<typeof v1CountsSchema>): Counts => ({
    passed: c.passed,
    failed: c.failed,
    skipped: c.skipped,
    executed: c.passed + c.failed,
    total: c.total,
  });
  const suites: SuiteResult[] = v1.suites.map((s) => ({
    key: s.key,
    name: s.name,
    // `passed` and `failed` mean the same in both versions and are already a
    // subset of Outcome, so this is a plain assignment: re-parsing would add a
    // throw path to a layer whose whole job is not to blow up on old files.
    status: s.status,
    durationMs: s.durationMs,
    counts: counts(s.counts),
    tests: s.tests.map((t) => ({
      name: t.name,
      fullName: t.fullName,
      status: t.status,
      durationMs: t.durationMs,
      ...(t.file ? { file: t.file } : {}),
    })),
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: v1.runId,
    source: v1.source,
    gitSha: v1.gitSha,
    gitRef: v1.gitRef,
    generatedAt: v1.generatedAt,
    overallStatus: v1.overallStatus,
    counts: counts(v1.counts),
    suites,
  };
}

/** Parse a summary of any known version, or `undefined` if it is neither. */
export function parseSummary(raw: unknown): VerifySummary | undefined {
  const v2 = verifySummarySchema.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = verifySummaryV1Schema.safeParse(raw);
  return v1.success ? upgradeV1(v1.data) : undefined;
}
