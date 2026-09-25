import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compactInstant, planBackfill, type RunInfo, runCli, runIdOf } from "../src/backfill.js";

const HISTORY = ["20260921T210209Z-35654014403.json", "20260925T130819Z-36138253484.json"];

function run(over: Partial<RunInfo> & { id: string }): RunInfo {
  return {
    workflow: "ci",
    event: "push",
    conclusion: "success",
    headBranch: "main",
    headSha: "a".repeat(40),
    updatedAt: "2026-09-25T14:00:00Z",
    ...over,
  };
}

describe("helpers", () => {
  it("runIdOf reads the run id from a history file name", () => {
    expect(runIdOf("20260925T130819Z-36138253484.json")).toBe("36138253484");
    expect(runIdOf("notes.txt")).toBeUndefined();
  });
  it("compactInstant matches the history file form", () => {
    expect(compactInstant("2026-09-25T13:08:19Z")).toBe("20260925T130819Z");
    expect(compactInstant("2026-09-25T13:08:19.456Z")).toBe("20260925T130819Z");
    expect(compactInstant("nope")).toBeUndefined();
  });
});

describe("planBackfill", () => {
  it("backfills a completed main ci run the history is missing, named by its instant", () => {
    expect(
      planBackfill(HISTORY, [run({ id: "36150000001", updatedAt: "2026-09-25T14:05:07Z" })]),
    ).toEqual([
      {
        runId: "36150000001",
        artifact: "pay-verify-summary",
        file: "20260925T140507Z-36150000001.json",
        headSha: "a".repeat(40),
      },
    ]);
  });

  it("uses the nightly artifact for a nightly run, failed runs included (a failure is a result)", () => {
    const [item] = planBackfill(HISTORY, [
      run({ id: "7", workflow: "e2e-nightly", event: "schedule", conclusion: "failure" }),
    ]);
    expect(item?.artifact).toBe("pay-verify-summary-nightly");
  });

  it("skips runs already in the history, and the triggering run", () => {
    expect(planBackfill(HISTORY, [run({ id: "36138253484" }), run({ id: "9" })], "9")).toEqual([]);
  });

  it("skips cancelled, skipped and unfinished runs — they tested nothing", () => {
    const runs = ["cancelled", "skipped", null].map((c, i) =>
      run({ id: String(i), conclusion: c }),
    );
    expect(planBackfill(HISTORY, runs)).toEqual([]);
  });

  it("skips runs that never feed the site: other branches, pull requests", () => {
    expect(
      planBackfill(HISTORY, [
        run({ id: "1", headBranch: "feature" }),
        run({ id: "2", event: "pull_request" }),
        run({ id: "3", workflow: "e2e-nightly", event: "push" }),
      ]),
    ).toEqual([]);
  });

  it("never resurrects a run older than the oldest retained history entry", () => {
    expect(planBackfill(HISTORY, [run({ id: "1", updatedAt: "2026-09-20T14:24:22Z" })])).toEqual(
      [],
    );
  });

  it("with no history yet, any fed run qualifies", () => {
    expect(planBackfill([], [run({ id: "1", updatedAt: "2026-09-01T00:00:00Z" })])).toHaveLength(1);
  });

  it("returns the items in chronological order, once each", () => {
    const items = planBackfill(HISTORY, [
      run({ id: "2", updatedAt: "2026-09-25T16:00:00Z" }),
      run({ id: "1", updatedAt: "2026-09-25T15:00:00Z" }),
      run({ id: "1", updatedAt: "2026-09-25T15:00:00Z" }),
    ]);
    expect(items.map((i) => i.runId)).toEqual(["1", "2"]);
  });
});

describe("runCli", () => {
  it("reads the history dir and a runs file, and prints tab-separated lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-"));
    const history = join(dir, "history");
    mkdirSync(history);
    for (const f of HISTORY) writeFileSync(join(history, f), "{}");
    const runs = join(dir, "runs.json");
    writeFileSync(runs, JSON.stringify([run({ id: "5", updatedAt: "2026-09-25T15:00:00Z" })]));
    expect(runCli(["--history", history, "--runs", runs])).toBe(
      `5\tpay-verify-summary\t20260925T150000Z-5.json\t${"a".repeat(40)}`,
    );
  });

  it("treats a missing history dir as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-"));
    const runs = join(dir, "runs.json");
    writeFileSync(runs, JSON.stringify([run({ id: "5" })]));
    expect(runCli(["--history", join(dir, "nope"), "--runs", runs])).toContain("5\t");
  });
});
