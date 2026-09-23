import { describe, expect, it } from "vitest";
import { assertPiiFree, findPii } from "../src/pii-guard.js";
import type { VerifySummary } from "../src/schema.js";

/** A realistic clean summary: synthetic titles, reserved-domain emails only. */
const CLEAN: VerifySummary = {
  schemaVersion: 2,
  runId: "12345",
  source: "ci",
  gitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
  gitRef: "refs/heads/main",
  generatedAt: "2026-09-21T12:00:00.000Z",
  overallStatus: "passed",
  counts: { passed: 2, failed: 0, skipped: 0, executed: 2, total: 2 },
  suites: [
    {
      key: "e2e",
      name: "Playwright journeys",
      status: "passed",
      durationMs: 200,
      counts: { passed: 2, failed: 0, skipped: 0, executed: 2, total: 2 },
      tests: [
        {
          name: "login: password + TOTP (fixed seeded credentials in live QA)",
          fullName: "auth login: password + TOTP",
          status: "passed",
          durationMs: 120,
        },
        {
          name: "email capture: mail to qa-admin@example.test lands in Mailpit",
          fullName: "qa email capture",
          status: "passed",
          durationMs: 80,
          file: "tests/qa.spec.ts",
        },
      ],
    },
  ],
};

describe("findPii — clean input", () => {
  it("does not flag reserved-domain emails, git shas, ISO dates or durations", () => {
    expect(findPii(CLEAN)).toEqual([]);
  });

  it("assertPiiFree does not throw on clean input", () => {
    expect(() => assertPiiFree(CLEAN)).not.toThrow();
  });
});

describe("findPii — planted PII", () => {
  it("flags a real-domain email", () => {
    const found = findPii({ title: "contact john.doe@gmail.com for approval" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "email", match: "john.doe@gmail.com" });
  });

  it("flags an SSN", () => {
    const found = findPii({ tests: [{ name: "SSN 123-45-6789 shown" }] });
    expect(found.map((f) => f.kind)).toContain("ssn");
    expect(found[0]?.path).toBe("tests.0.name");
  });

  it("flags an EIN", () => {
    expect(findPii("company EIN 12-3456789").map((f) => f.kind)).toContain("ein");
  });

  it("flags a US phone number", () => {
    expect(findPii("call (415) 555-2671 now").map((f) => f.kind)).toContain("phone");
  });

  it("assertPiiFree throws and names the finding", () => {
    expect(() => assertPiiFree({ a: { b: "reach me at jane@evil.example.io" } })).toThrow(/email/);
  });
});

describe("findPii — ReDoS resistance (bounded regex)", () => {
  it("returns fast on a pathological non-matching string", () => {
    // A naive email regex backtracks polynomially here; the bounded one is linear.
    const evil = `${"%".repeat(50_000)}@${"a".repeat(50_000)}`;
    const start = Date.now();
    const found = findPii(evil);
    expect(Date.now() - start).toBeLessThan(1000);
    // No TLD (no dotted domain) → not a valid email match → no finding.
    expect(found).toEqual([]);
  });

  it("still flags a normal email after the change", () => {
    expect(findPii("x@sub.gmail.com").map((f) => f.kind)).toContain("email");
  });
});
