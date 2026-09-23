import { describe, expect, it } from "vitest";
import { type VerifySummary, verifySummarySchema } from "../src/schema.js";

const VALID: VerifySummary = {
  schemaVersion: 2,
  runId: "run-1",
  source: "nightly",
  gitSha: "abc123",
  gitRef: "refs/heads/main",
  generatedAt: "2026-09-21T12:00:00.000Z",
  overallStatus: "failed",
  counts: { passed: 1, failed: 1, flaky: 0, skipped: 0, executed: 2, total: 2 },
  suites: [
    {
      key: "e2e",
      name: "Playwright journeys",
      status: "failed",
      durationMs: 10,
      counts: { passed: 1, failed: 1, flaky: 0, skipped: 0, executed: 2, total: 2 },
      tests: [{ name: "t", fullName: "t", status: "failed", durationMs: 10 }],
    },
  ],
};

describe("verifySummarySchema", () => {
  it("accepts a valid summary", () => {
    expect(verifySummarySchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() => verifySummarySchema.parse({ ...VALID, schemaVersion: 3 })).toThrow();
  });

  it("rejects an unknown suite key", () => {
    const bad = { ...VALID, suites: [{ ...VALID.suites[0], key: "unit" }] };
    expect(() => verifySummarySchema.parse(bad)).toThrow();
  });
});
