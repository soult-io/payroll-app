import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSuite, parseArgs, readJson } from "../src/cli.js";

const tmp = mkdtempSync(join(tmpdir(), "verify-summary-"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("parses flags into inputs + required keys", () => {
    const args = parseArgs([
      "--source",
      "nightly",
      "--out",
      "out.json",
      "--vitest",
      "engine=e.json",
      "--playwright",
      "e2e=p.json",
      "--require",
      "engine,e2e",
    ]);
    expect(args.source).toBe("nightly");
    expect(args.out).toBe("out.json");
    expect(args.inputs).toEqual([
      { kind: "vitest", key: "engine", file: "e.json" },
      { kind: "playwright", key: "e2e", file: "p.json" },
    ]);
    expect(args.requiredSuiteKeys).toEqual(["engine", "e2e"]);
  });

  it("rejects an invalid --source (does not silently coerce)", () => {
    expect(() => parseArgs(["--source", "prod"])).toThrow();
  });

  it("rejects an unknown suite key", () => {
    expect(() => parseArgs(["--vitest", "unit=x.json"])).toThrow();
  });
});

describe("readJson — resilience (spec 17 §2: omit, never crash)", () => {
  it("returns undefined and warns when the file is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readJson(join(tmp, "does-not-exist.json"))).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns undefined and warns on unparseable json", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not valid json", "utf8");
    expect(readJson(bad)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("parses valid json", () => {
    const good = join(tmp, "good.json");
    writeFileSync(good, JSON.stringify({ testResults: [] }), "utf8");
    expect(readJson(good)).toEqual({ testResults: [] });
  });
});

describe("loadSuite", () => {
  it("omits a suite whose reporter file is absent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      loadSuite({ kind: "vitest", key: "server", file: join(tmp, "nope.json") }),
    ).toBeUndefined();
  });

  it("builds a suite from a present vitest report", () => {
    const file = join(tmp, "engine.json");
    writeFileSync(
      file,
      JSON.stringify({
        testResults: [
          { name: "a.test.ts", assertionResults: [{ title: "ok", status: "passed", duration: 1 }] },
        ],
      }),
      "utf8",
    );
    const suite = loadSuite({ kind: "vitest", key: "engine", file });
    expect(suite?.key).toBe("engine");
    expect(suite?.counts.total).toBe(1);
  });
});
