import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifySummary } from "@payroll/verify-summary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHistory } from "../src/generate.js";

const tmp = mkdtempSync(join(tmpdir(), "verify-site-"));

function valid(over: Partial<VerifySummary> = {}): VerifySummary {
  return {
    schemaVersion: 1,
    runId: "r",
    source: "ci",
    gitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    gitRef: "refs/heads/main",
    generatedAt: "2026-09-21T00:00:00.000Z",
    overallStatus: "passed",
    counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
    suites: [
      {
        key: "engine",
        name: "Engine unit tests",
        status: "passed",
        durationMs: 1,
        counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
        tests: [{ name: "ok", fullName: "ok", status: "passed", durationMs: 1 }],
      },
    ],
    ...over,
  };
}

function write(name: string, content: unknown): void {
  writeFileSync(
    join(tmp, name),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadHistory", () => {
  it("returns empty for an absent directory", () => {
    expect(loadHistory(join(tmp, "nope"))).toEqual([]);
  });

  it("loads valid summaries and skips non-json files", () => {
    write("a.json", valid());
    write("notes.txt", "ignore me");
    const loaded = loadHistory(tmp);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    // Spec 18 §Back-compat: the fixture is v1 (as every retained history file
    // is) and comes back upgraded, which is the proof that old runs still render.
    expect(loaded.every((s) => s.schemaVersion === 2)).toBe(true);
    expect(loaded.every((s) => s.counts.flaky === undefined)).toBe(true);
  });

  it("skips unparseable and schema-invalid files without throwing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    write("bad.json", "{ not json");
    write("wrong.json", { schemaVersion: 1, nope: true });
    // still returns the valid one written above, never throws
    expect(() => loadHistory(tmp)).not.toThrow();
  });

  it("skips (does not render) a PII-poisoned but schema-valid file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poisoned = valid({
      runId: "poison",
      suites: [
        {
          key: "server",
          name: "Server integration tests",
          status: "passed",
          durationMs: 1,
          counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
          tests: [
            { name: "leak", fullName: "email john.doe@gmail.com", status: "passed", durationMs: 1 },
          ],
        },
      ],
    });
    write("poison.json", poisoned);
    const loaded = loadHistory(tmp);
    expect(loaded.some((s) => s.runId === "poison")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
