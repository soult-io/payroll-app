import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifySummaryV1 } from "@payroll/verify-summary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHistory, uniqueRuns } from "../src/generate.js";

const tmp = mkdtempSync(join(tmpdir(), "verify-site-"));

// Deliberately a v1 fixture, typed as v1: every file in the retained history
// window is v1, and loadHistory must keep rendering them (spec 18 §Back-compat).
function valid(over: Partial<VerifySummaryV1> = {}): VerifySummaryV1 {
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
    expect(loadHistory(join(tmp, "nope"))).toEqual({ summaries: [], skipped: 0 });
  });

  it("loads valid summaries and skips non-json files", () => {
    write("a.json", valid());
    write("notes.txt", "ignore me");
    const { summaries: loaded, skipped } = loadHistory(tmp);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(skipped).toBe(0);
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
    const { summaries: loaded, skipped } = loadHistory(tmp);
    expect(loaded.some((s) => s.runId === "poison")).toBe(false);
    // Counted, not just logged — the footer says so on the page (spec 18).
    expect(skipped).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("uniqueRuns (spec 21)", () => {
  // Summaries only need source / runId / generatedAt here.
  const s = (runId: string, source: "ci" | "nightly", generatedAt: string) =>
    ({ runId, source, generatedAt }) as Parameters<typeof uniqueRuns>[0][number];

  it("keeps one summary per run when a run reached the history twice", () => {
    const out = uniqueRuns([
      s("7", "ci", "2026-09-25T13:00:00Z"),
      s("7", "ci", "2026-09-25T13:05:00Z"),
      s("8", "ci", "2026-09-25T14:00:00Z"),
    ]);
    expect(out.map((x) => `${x.runId}@${x.generatedAt}`).sort()).toEqual([
      "7@2026-09-25T13:05:00Z",
      "8@2026-09-25T14:00:00Z",
    ]);
  });

  it("treats the same run id from different sources as different runs", () => {
    expect(
      uniqueRuns([s("7", "ci", "2026-09-25T13:00:00Z"), s("7", "nightly", "2026-09-25T13:00:00Z")]),
    ).toHaveLength(2);
  });

  it("loadHistory drops a duplicated run file", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-dup-"));
    writeFileSync(join(dir, "20260925T130000Z-42.json"), JSON.stringify(valid({ runId: "42" })));
    writeFileSync(join(dir, "20260925T130500Z-42.json"), JSON.stringify(valid({ runId: "42" })));
    expect(loadHistory(dir).summaries).toHaveLength(1);
  });
});
