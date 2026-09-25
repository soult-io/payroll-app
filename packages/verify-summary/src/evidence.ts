/**
 * Spec 20 (PAY-78) — the journey-evidence file the e2e evidence reporter
 * (e2e/reporters/evidence-reporter.ts) writes beside the step stills.
 *
 * Evidence is a separate file from the summary: joined to the summary's e2e
 * tests by `fullName`, and bound to one run by `runId` + `commitSha`. Nothing
 * from it is shown unless it parses here AND carries no PII-shaped string.
 */

import { z } from "zod";
import { findPii } from "./pii-guard.js";

export const EVIDENCE_SCHEMA = "journey-evidence/1";

/**
 * The e2e spec files whose tests are journeys (spec 20 D4) — the only tests
 * that ever carry evidence. Kept in step with JOURNEY_FILES in
 * e2e/reporters/evidence-reporter.ts (the e2e package does not depend on this
 * one); a test on each side pins the same list.
 */
export const JOURNEY_SPEC_FILES: ReadonlySet<string> = new Set([
  "journeys.spec.ts",
  "qa.spec.ts",
  "state-taxes.spec.ts",
]);

/** Still height cap (CSS px) the capture helper enforces. */
export const STILL_MAX_HEIGHT_PX = 4000;

export const stillRecordSchema = z.object({
  /** Relative to the evidence file's directory; forward slashes. */
  path: z.string().min(1),
  contentType: z.literal("image/jpeg"),
  width: z.number().int().positive(),
  height: z.number().int().positive().max(STILL_MAX_HEIGHT_PX),
  /** The screen was cut at the height cap. */
  truncated: z.boolean(),
});
export type StillRecord = z.infer<typeof stillRecordSchema>;

export const evidenceStepSchema = z.object({
  title: z.string(),
  status: z.enum(["passed", "failed"]),
  durationMs: z.number().nonnegative(),
  /** null = no still was produced; never a placeholder. */
  screenshot: stillRecordSchema.nullable(),
});
export type EvidenceStep = z.infer<typeof evidenceStepSchema>;

export const journeyRecordSchema = z.object({
  testId: z.string(),
  /** File + describes + title: the summary's e2e `fullName`. */
  fullName: z.string(),
  title: z.string(),
  file: z.string(),
  status: z.enum(["passed", "failed", "flaky", "skipped", "timedOut"]),
  /** 1-based attempt the steps come from (the final one). */
  attempt: z.number().int().positive(),
  steps: z.array(evidenceStepSchema),
});
export type JourneyRecord = z.infer<typeof journeyRecordSchema>;

export const journeyEvidenceSchema = z.object({
  schema: z.literal(EVIDENCE_SCHEMA),
  mode: z.literal("gating"),
  commitSha: z.string(),
  runId: z.string(),
  /** Spec 20 D2: evidence is captured on CI only, never the nightly. */
  source: z.literal("ci"),
  generatedAt: z.string(),
  journeys: z.array(journeyRecordSchema),
});
export type JourneyEvidence = z.infer<typeof journeyEvidenceSchema>;

/**
 * Parse an evidence file. `undefined` when it does not match the schema OR
 * any string in it is PII-shaped — the whole file is refused, never partly
 * shown, so a poisoned title cannot reach the page.
 */
export function parseEvidence(raw: unknown): JourneyEvidence | undefined {
  const parsed = journeyEvidenceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  if (findPii(parsed.data).length > 0) return undefined;
  return parsed.data;
}

// --- walkthrough (spec 20, PAY-78 PR 5–7) -----------------------------------

export const WALKTHROUGH_SCHEMA = "journey-walkthrough/1";

export const walkthroughStepSchema = z.object({
  title: z.string(),
  status: z.enum(["passed", "failed"]),
  /** Start of the step in the journey's joined video (ms); null when unplaceable. */
  offsetMs: z.number().nonnegative().nullable(),
});
export type WalkthroughStep = z.infer<typeof walkthroughStepSchema>;

export const walkthroughJourneySchema = z.object({
  testId: z.string(),
  fullName: z.string(),
  title: z.string(),
  file: z.string(),
  status: z.enum(["passed", "failed", "flaky", "skipped", "timedOut"]),
  video: z
    .object({
      /** Relative to the evidence file's directory; forward slashes. */
      path: z.string().min(1),
      contentType: z.literal("video/webm"),
      durationMs: z.number().positive(),
    })
    .nullable(),
  steps: z.array(walkthroughStepSchema),
});
export type WalkthroughJourney = z.infer<typeof walkthroughJourneySchema>;

export const walkthroughEvidenceSchema = z.object({
  schema: z.literal(WALKTHROUGH_SCHEMA),
  mode: z.literal("walkthrough"),
  /** The TESTED commit the recording re-ran. */
  commitSha: z.string(),
  /** The ci run whose gating result it sits beside; null off main (never published). */
  gatingRunId: z.string().nullable(),
  /** The walkthrough's own run. */
  runId: z.string(),
  source: z.literal("ci"),
  generatedAt: z.string(),
  journeys: z.array(walkthroughJourneySchema),
});
export type WalkthroughEvidence = z.infer<typeof walkthroughEvidenceSchema>;

/**
 * Parse a walkthrough evidence file. `undefined` when it does not match the
 * schema, carries no gating run (a PR / manual recording is never published),
 * or any string in it is PII-shaped — the whole file is refused.
 */
export function parseWalkthrough(raw: unknown): WalkthroughEvidence | undefined {
  const parsed = walkthroughEvidenceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.gatingRunId === null) return undefined;
  if (findPii(parsed.data).length > 0) return undefined;
  return parsed.data;
}
