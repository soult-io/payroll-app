/**
 * Journey-evidence reporter (spec 20, PAY-78).
 *
 * Writes `journey-evidence.json` (schema `journey-evidence/1`): for every
 * journey test, its FINAL attempt's steps and the still each step attached
 * (tests/support/journey.ts). The pay-verify site joins it to the run's
 * summary by `fullName` and binds it by `runId` + `commitSha` — so nothing on
 * a card exists unless this run produced it.
 *
 * Still paths are written relative to the evidence file's directory, so the
 * file and its stills can be moved as one bundle.
 *
 * Registered only for the ephemeral CI run (playwright.config.ts): never for
 * the nightly live-QA run (spec 20 D2).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

export const EVIDENCE_SCHEMA = "journey-evidence/1";

/** Attachment name the `step` helper gives a step's still. */
export const STEP_STILL_ATTACHMENT = "step-still";
/** Attachment (JSON body, a StillMeta) the helper adds right after each still. */
export const STEP_STILL_META_ATTACHMENT = "step-still-meta";
/** Annotation the helper adds when a still could not be taken, with the reason. */
export const STILL_MISSING_ANNOTATION = "step-still-missing";

/**
 * The spec files whose tests are journeys (spec 20 D4). Utility specs
 * (mobile-login, qa-helpers) get no evidence.
 */
export const JOURNEY_FILES: ReadonlySet<string> = new Set([
  "journeys.spec.ts",
  "qa.spec.ts",
  "state-taxes.spec.ts",
]);

export interface StillMeta {
  width: number;
  height: number;
  /** True when the screen was cut at the height cap — never silent. */
  truncated: boolean;
}

export interface StillRecord extends StillMeta {
  path: string;
  contentType: "image/jpeg";
}

export interface StepRecord {
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  /** The step's still, or null: no still was produced (never a placeholder). */
  screenshot: StillRecord | null;
}

export type JourneyStatus = "passed" | "failed" | "flaky" | "skipped" | "timedOut";

export interface JourneyRecord {
  /** Playwright's stable test id. */
  testId: string;
  /** File + describe path + title, space-joined: the summary's `fullName`. */
  fullName: string;
  title: string;
  file: string;
  status: JourneyStatus;
  /** 1-based attempt the steps come from (the final one). */
  attempt: number;
  steps: StepRecord[];
}

export interface JourneyEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  mode: "gating";
  commitSha: string;
  runId: string;
  source: "ci";
  generatedAt: string;
  journeys: JourneyRecord[];
}

type Attachment = TestStep["attachments"][number];

/** The helper's StillMeta body, or null when missing or malformed. */
export function readStillMeta(body: Buffer | undefined): StillMeta | null {
  if (!body) return null;
  try {
    const m = JSON.parse(body.toString("utf8")) as Partial<StillMeta>;
    const sizeOk = [m.width, m.height].every((n) => Number.isInteger(n) && (n as number) > 0);
    if (sizeOk && typeof m.truncated === "boolean") {
      return { width: m.width as number, height: m.height as number, truncated: m.truncated };
    }
  } catch {
    // Unreadable meta: the still is dropped (see findStill).
  }
  return null;
}

/**
 * A still path relative to the evidence directory, or null when it would
 * escape it (a still outside the bundle cannot be served).
 */
export function bundlePath(evidenceDir: string, stillPath: string): string | null {
  const rel = relative(evidenceDir, stillPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The step's own still: attached by a direct (non-`test.step`) child. A still
 * whose meta is missing or unreadable is dropped — a record with no size or
 * truncation flag would let the page guess.
 */
export function findStill(steps: readonly TestStep[], evidenceDir: string): StillRecord | null {
  let path: string | null = null;
  let still: StillRecord | null = null;
  const visit = (a: Attachment): void => {
    if (a.name === STEP_STILL_ATTACHMENT && a.path) {
      path = bundlePath(evidenceDir, a.path);
      still = null;
    } else if (a.name === STEP_STILL_META_ATTACHMENT && path) {
      const meta = readStillMeta(a.body);
      still = meta ? { path, contentType: "image/jpeg", ...meta } : null;
      path = null;
    }
  };
  const walk = (list: readonly TestStep[]): void => {
    for (const s of list) {
      if (s.category === "test.step") continue;
      for (const a of s.attachments) visit(a);
      walk(s.steps);
    }
  };
  walk(steps);
  return still;
}

/** Top-level `test.step`s of an attempt, each with its still. */
export function collectSteps(steps: readonly TestStep[], evidenceDir: string): StepRecord[] {
  return steps
    .filter((s) => s.category === "test.step")
    .map((s) => ({
      title: s.title,
      status: s.error ? "failed" : "passed",
      durationMs: Math.round(s.duration),
      screenshot: findStill(s.steps, evidenceDir),
    }));
}

/** A flaky test is never a clean pass; an interrupted one did not pass. */
export function journeyStatus(
  outcome: ReturnType<TestCase["outcome"]>,
  status: TestResult["status"],
): JourneyStatus {
  if (outcome === "flaky") return "flaky";
  if (status === "interrupted") return "failed";
  return status;
}

export default class EvidenceReporter implements Reporter {
  private readonly outputFile: string;
  private readonly finals = new Map<string, { test: TestCase; result: TestResult }>();

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(options.outputFile ?? "test-results/journey-evidence.json");
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!JOURNEY_FILES.has(basename(test.location.file))) return;
    const prev = this.finals.get(test.id);
    if (!prev || result.retry >= prev.result.retry) this.finals.set(test.id, { test, result });
  }

  onEnd(_result: FullResult): void {
    const evidenceDir = dirname(this.outputFile);
    const journeys = [...this.finals.values()].map(({ test, result }) => ({
      testId: test.id,
      // titlePath() = ["", project, file, ...describes, title]; the Playwright
      // json report (and so the summary) names a test by file + describes + title.
      fullName: test.titlePath().slice(2).join(" "),
      title: test.title,
      file: basename(test.location.file),
      status: journeyStatus(test.outcome(), result.status),
      attempt: result.retry + 1,
      steps: collectSteps(result.steps, evidenceDir),
    }));
    const evidence: JourneyEvidence = {
      schema: EVIDENCE_SCHEMA,
      mode: "gating",
      commitSha: process.env.GITHUB_SHA ?? "local",
      runId: process.env.GITHUB_RUN_ID ?? "local",
      source: "ci",
      generatedAt: new Date().toISOString(),
      journeys,
    };
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
