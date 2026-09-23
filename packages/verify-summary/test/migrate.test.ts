import { describe, expect, it } from "vitest";
import { parseSummary, upgradeV1 } from "../src/migrate.js";

// A real v1 summary shape, trimmed — every file in the retained history window
// on the pay-verify-data branch looks like this.
const V1 = {
  schemaVersion: 1,
  runId: "35787941623",
  source: "ci",
  gitSha: "b696a6fc34c3008bb2161f70319625232dc2e0d2",
  gitRef: "refs/heads/main",
  generatedAt: "2026-09-22T21:44:42.000Z",
  overallStatus: "passed",
  counts: { passed: 542, failed: 0, skipped: 6, total: 548 },
  suites: [
    {
      key: "e2e",
      name: "Playwright journeys",
      status: "passed",
      durationMs: 76_000,
      counts: { passed: 14, failed: 0, skipped: 6, total: 20 },
      tests: [
        {
          name: "journey 1: invite onboarding wizard",
          fullName: "journey 1: invite onboarding wizard",
          status: "passed",
          durationMs: 1_500,
          file: "journeys.spec.ts",
        },
      ],
    },
  ],
};

describe("upgradeV1", () => {
  const up = upgradeV1(V1 as never);

  it("stamps schema version 2", () => {
    expect(up.schemaVersion).toBe(2);
  });

  it("leaves flaky ABSENT, not zero — v1 folded flakes into passed and the count is unknowable", () => {
    expect(up.counts.flaky).toBeUndefined();
    expect(up.suites[0]?.counts.flaky).toBeUndefined();
  });

  it("derives executed from passed + failed", () => {
    expect(up.counts.executed).toBe(542);
    expect(up.suites[0]?.counts.executed).toBe(14);
  });

  it("carries the v1 outcome across unchanged", () => {
    expect(up.overallStatus).toBe("passed");
    expect(up.suites[0]?.status).toBe("passed");
  });

  it("leaves the v2-only per-test fields absent", () => {
    const t = up.suites[0]?.tests[0];
    expect(t?.attempts).toBeUndefined();
    expect(t?.firstFailure).toBeUndefined();
    expect(t?.skipReason).toBeUndefined();
  });
});

describe("parseSummary", () => {
  it("accepts a v1 file and returns it upgraded", () => {
    const parsed = parseSummary(V1);
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.counts.executed).toBe(542);
  });

  it("accepts a native v2 file unchanged", () => {
    const v2 = upgradeV1(V1 as never);
    expect(parseSummary(v2)).toEqual(v2);
  });

  it("returns undefined for something that is neither", () => {
    expect(parseSummary({ schemaVersion: 99 })).toBeUndefined();
    expect(parseSummary("not an object")).toBeUndefined();
  });
});
