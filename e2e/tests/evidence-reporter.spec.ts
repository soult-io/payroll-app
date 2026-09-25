/**
 * Spec 20 (PAY-78): the journey-evidence reporter's pure parts, on hand-built
 * step trees shaped like Playwright's reporter API.
 */

import { expect, test } from "@playwright/test";
import type { TestStep } from "@playwright/test/reporter";
import {
  bundlePath,
  collectSteps,
  findStill,
  JOURNEY_FILES,
  journeyStatus,
  readStillMeta,
  STEP_STILL_ATTACHMENT,
  STEP_STILL_META_ATTACHMENT,
} from "../reporters/evidence-reporter.js";

const DIR = "/run/e2e/test-results";
const META = { width: 1280, height: 2100, truncated: false };

type Att = TestStep["attachments"][number];

function stillAtt(path: string): Att {
  return { name: STEP_STILL_ATTACHMENT, contentType: "image/jpeg", path };
}
function metaAtt(body: unknown): Att {
  return {
    name: STEP_STILL_META_ATTACHMENT,
    contentType: "application/json",
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Minimal TestStep: only the fields the reporter reads. */
function mk(
  category: string,
  title: string,
  opts: { attachments?: Att[]; steps?: TestStep[]; error?: boolean; duration?: number } = {},
): TestStep {
  return {
    category,
    title,
    attachments: opts.attachments ?? [],
    steps: opts.steps ?? [],
    duration: opts.duration ?? 10,
    ...(opts.error ? { error: { message: "x" } } : {}),
  } as unknown as TestStep;
}

/** A journey step whose still + meta are attached by a nested attach step. */
function stepWithStill(title: string, path: string, meta: unknown = META): TestStep {
  return mk("test.step", title, {
    steps: [
      mk("expect", "toBeVisible"),
      mk("test.attach", "attach", { attachments: [stillAtt(path)] }),
      mk("test.attach", "attach", { attachments: [metaAtt(meta)] }),
    ],
  });
}

test.describe("harness · evidence reporter", () => {
  test("bundlePath: relative, forward slashes, and never outside the bundle", () => {
    expect(bundlePath(DIR, `${DIR}/j1-chromium/step-still-00.jpg`)).toBe(
      "j1-chromium/step-still-00.jpg",
    );
    expect(bundlePath(DIR, "/run/e2e/elsewhere/a.jpg")).toBeNull();
    expect(bundlePath(DIR, DIR)).toBeNull();
  });

  test("readStillMeta: accepts a valid meta, rejects missing or malformed ones", () => {
    expect(readStillMeta(Buffer.from(JSON.stringify(META)))).toEqual(META);
    expect(readStillMeta(undefined)).toBeNull();
    expect(readStillMeta(Buffer.from("{not json"))).toBeNull();
    expect(
      readStillMeta(Buffer.from(JSON.stringify({ width: 0, height: 5, truncated: false }))),
    ).toBeNull();
    expect(readStillMeta(Buffer.from(JSON.stringify({ width: 5, height: 5 })))).toBeNull();
  });

  test("collectSteps: one record per top-level step, with its own still", () => {
    const steps = [
      mk("hook", "Before Hooks"),
      stepWithStill("open run", `${DIR}/t/step-still-00.jpg`),
      stepWithStill("approve", `${DIR}/t/step-still-01.jpg`, { ...META, truncated: true }),
      mk("hook", "After Hooks"),
    ];
    expect(collectSteps(steps, DIR)).toEqual([
      {
        title: "open run",
        status: "passed",
        durationMs: 10,
        screenshot: { path: "t/step-still-00.jpg", contentType: "image/jpeg", ...META },
      },
      {
        title: "approve",
        status: "passed",
        durationMs: 10,
        screenshot: {
          path: "t/step-still-01.jpg",
          contentType: "image/jpeg",
          ...META,
          truncated: true,
        },
      },
    ]);
  });

  test("collectSteps: a step with no still records null, never a neighbour's image", () => {
    const steps = [
      stepWithStill("first", `${DIR}/t/step-still-00.jpg`),
      mk("test.step", "capture failed", { steps: [mk("expect", "toBeVisible")] }),
    ];
    const [first, second] = collectSteps(steps, DIR);
    expect(first?.screenshot?.path).toBe("t/step-still-00.jpg");
    expect(second?.screenshot).toBeNull();
  });

  test("collectSteps: a failed step is failed and keeps its still", () => {
    const failed = stepWithStill("fails", `${DIR}/t/step-still-00.jpg`);
    (failed as { error?: unknown }).error = { message: "boom" };
    const [rec] = collectSteps([failed], DIR);
    expect(rec?.status).toBe("failed");
    expect(rec?.screenshot).not.toBeNull();
  });

  test("findStill: a still with unreadable meta is dropped, not guessed", () => {
    const s = stepWithStill("bad meta", `${DIR}/t/step-still-00.jpg`, "{oops");
    expect(findStill(s.steps, DIR)).toBeNull();
  });

  test("findStill: a nested test.step's still belongs to the nested step", () => {
    const outer = mk("test.step", "outer", {
      steps: [stepWithStill("inner", `${DIR}/t/step-still-00.jpg`)],
    });
    expect(findStill(outer.steps, DIR)).toBeNull();
  });

  test("findStill: a still path outside the bundle is dropped", () => {
    const s = stepWithStill("escapes", "/tmp/elsewhere.jpg");
    expect(findStill(s.steps, DIR)).toBeNull();
  });

  test("journeyStatus: flaky is never a clean pass; interrupted is a failure", () => {
    expect(journeyStatus("flaky", "passed")).toBe("flaky");
    expect(journeyStatus("expected", "passed")).toBe("passed");
    expect(journeyStatus("unexpected", "timedOut")).toBe("timedOut");
    expect(journeyStatus("unexpected", "interrupted")).toBe("failed");
    expect(journeyStatus("skipped", "skipped")).toBe("skipped");
  });

  test("JOURNEY_FILES: the spec 20 D4 journey set, utility specs excluded", () => {
    expect([...JOURNEY_FILES].sort()).toEqual([
      "journeys.spec.ts",
      "qa.spec.ts",
      "state-taxes.spec.ts",
    ]);
    expect(JOURNEY_FILES.has("mobile-login.spec.ts")).toBe(false);
    expect(JOURNEY_FILES.has("qa-helpers.spec.ts")).toBe(false);
  });
});
