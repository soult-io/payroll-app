import { describe, expect, it } from "vitest";
import {
  JOURNEY_SPEC_FILES,
  type JourneyEvidence,
  parseEvidence,
  parseWalkthrough,
} from "../src/evidence.js";

/** Shaped like the e2e evidence reporter's real output (spec 20). */
function evidence(over: Partial<JourneyEvidence> = {}): JourneyEvidence {
  return {
    schema: "journey-evidence/1",
    mode: "gating",
    commitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    runId: "36119179049",
    source: "ci",
    generatedAt: "2026-09-25T09:40:00.000Z",
    journeys: [
      {
        testId: "2d6887e324933beb1cf7-c4506eccf01684da792e",
        fullName: "journeys.spec.ts journey 2: admin approves + issues payroll run",
        title: "journey 2: admin approves + issues payroll run",
        file: "journeys.spec.ts",
        status: "passed",
        attempt: 1,
        steps: [
          {
            title: "Approve the run",
            status: "passed",
            durationMs: 812,
            screenshot: {
              path: "journeys-journey-2-chromium/attachments/step-still-3ae4f34e524efc0c67d4dd74a5e7341c835a2f85.jpg",
              contentType: "image/jpeg",
              width: 1280,
              height: 992,
              truncated: false,
            },
          },
          { title: "Issue the payslip", status: "failed", durationMs: 90, screenshot: null },
        ],
      },
    ],
    ...over,
  };
}

describe("parseEvidence", () => {
  it("accepts the reporter's shape", () => {
    expect(parseEvidence(evidence())?.runId).toBe("36119179049");
  });

  it("refuses another schema version", () => {
    expect(parseEvidence({ ...evidence(), schema: "journey-evidence/2" })).toBeUndefined();
  });

  it("refuses nightly evidence (spec 20 D2: CI only)", () => {
    expect(parseEvidence({ ...evidence(), source: "nightly" })).toBeUndefined();
  });

  it("refuses a still taller than the capture cap", () => {
    const e = evidence();
    const step = e.journeys[0]?.steps[0];
    if (step?.screenshot) step.screenshot.height = 4001;
    expect(parseEvidence(e)).toBeUndefined();
  });

  it("refuses a still that is not a JPEG record", () => {
    const e = evidence();
    const step = e.journeys[0]?.steps[0];
    if (step?.screenshot) (step.screenshot as { contentType: string }).contentType = "image/png";
    expect(parseEvidence(e)).toBeUndefined();
  });

  it("refuses the WHOLE file when any string is PII-shaped", () => {
    const e = evidence();
    const step = e.journeys[0]?.steps[1];
    if (step) step.title = "Enter SSN 123-45-6789";
    expect(parseEvidence(e)).toBeUndefined();
  });

  it("keeps hex ids, hashes and reserved-domain emails (no false PII)", () => {
    const e = evidence();
    const step = e.journeys[0]?.steps[1];
    if (step) step.title = "Invite e2e-employee@example.test";
    expect(parseEvidence(e)).toBeDefined();
  });
});

describe("JOURNEY_SPEC_FILES", () => {
  // Same list as JOURNEY_FILES in e2e/reporters/evidence-reporter.ts (pinned there too).
  it("is the spec 20 D4 journey set", () => {
    expect([...JOURNEY_SPEC_FILES].sort()).toEqual([
      "journeys.spec.ts",
      "qa.spec.ts",
      "state-taxes.spec.ts",
    ]);
  });
});

describe("parseWalkthrough", () => {
  const base = {
    schema: "journey-walkthrough/1",
    mode: "walkthrough",
    commitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    gatingRunId: "36119179049",
    runId: "36131806661",
    source: "ci",
    generatedAt: "2026-09-25T12:00:00.000Z",
    journeys: [
      {
        testId: "a-b",
        fullName: "journeys.spec.ts journey 1",
        title: "journey 1",
        file: "journeys.spec.ts",
        status: "passed",
        video: { path: "videos/j1.webm", contentType: "video/webm", durationMs: 43_600 },
        steps: [{ title: "Set a password", status: "passed", offsetMs: 1500 }],
      },
    ],
  };

  it("accepts the reporter's shape", () => {
    expect(parseWalkthrough(base)?.gatingRunId).toBe("36119179049");
  });

  it("refuses a recording with no gating run", () => {
    expect(parseWalkthrough({ ...base, gatingRunId: null })).toBeUndefined();
  });

  it("refuses a non-webm video record", () => {
    const bad = structuredClone(base);
    (bad.journeys[0]?.video as { contentType: string }).contentType = "video/mp4";
    expect(parseWalkthrough(bad)).toBeUndefined();
  });

  it("refuses the whole file when any string is PII-shaped", () => {
    const bad = structuredClone(base);
    const step = bad.journeys[0]?.steps[0];
    if (step) step.title = "Enter SSN 123-45-6789";
    expect(parseWalkthrough(bad)).toBeUndefined();
  });
});
