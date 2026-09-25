import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JourneyEvidence } from "@payroll/verify-summary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvidence, MAX_MEDIA_BYTES, MAX_STILL_BYTES } from "../src/generate.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function bundle(): { dir: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  return { dir: join(root, "bundle"), out: join(root, "site") };
}

function put(dir: string, rel: string, bytes: Buffer): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

function still(path: string) {
  return { path, contentType: "image/jpeg" as const, width: 1280, height: 900, truncated: false };
}

function writeEvidence(dir: string, paths: (string | null)[]): void {
  const e: JourneyEvidence = {
    schema: "journey-evidence/1",
    mode: "gating",
    commitSha: "abc1234",
    runId: "42",
    source: "ci",
    generatedAt: "2026-09-25T09:40:00.000Z",
    journeys: [
      {
        testId: "t1",
        fullName: "journeys.spec.ts journey 1",
        title: "journey 1",
        file: "journeys.spec.ts",
        status: "passed",
        attempt: 1,
        steps: paths.map((p, i) => ({
          title: `step ${i + 1}`,
          status: "passed" as const,
          durationMs: 1,
          screenshot: p === null ? null : still(p),
        })),
      },
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journey-evidence.json"), JSON.stringify(e));
}

function stillsOf(loaded: ReturnType<typeof loadEvidence>) {
  return loaded?.index.journeys.get("journeys.spec.ts journey 1")?.steps.map((s) => s.still);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadEvidence", () => {
  it("returns undefined when there is no bundle", () => {
    const { dir, out } = bundle();
    expect(loadEvidence(dir, out)).toBeUndefined();
  });

  it("copies a valid still under media/ci and serves it by a relative href", () => {
    const { dir, out } = bundle();
    put(dir, "j1/attachments/step-still-aa.jpg", JPEG);
    writeEvidence(dir, ["j1/attachments/step-still-aa.jpg"]);
    const loaded = loadEvidence(dir, out);
    expect(loaded?.index).toMatchObject({ runId: "42", commitSha: "abc1234" });
    expect(stillsOf(loaded)).toEqual([
      {
        href: "media/ci/j1/attachments/step-still-aa.jpg",
        width: 1280,
        height: 900,
        truncated: false,
      },
    ]);
    expect(readFileSync(join(out, "media/ci/j1/attachments/step-still-aa.jpg"))).toEqual(JPEG);
  });

  it("keeps a null still null — never a placeholder", () => {
    const { dir, out } = bundle();
    writeEvidence(dir, [null]);
    expect(stillsOf(loadEvidence(dir, out))).toEqual([null]);
  });

  it("refuses a still that is not a JPEG, and does not copy it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    put(dir, "j1/fake.jpg", Buffer.from("<svg onload=alert(1)>"));
    writeEvidence(dir, ["j1/fake.jpg"]);
    const loaded = loadEvidence(dir, out);
    expect(stillsOf(loaded)).toEqual([null]);
    expect(loaded?.refused).toBe(1);
    expect(existsSync(join(out, "media/ci/j1/fake.jpg"))).toBe(false);
  });

  it("refuses a missing file", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    writeEvidence(dir, ["j1/gone.jpg"]);
    expect(stillsOf(loadEvidence(dir, out))).toEqual([null]);
  });

  it("refuses a path that escapes the bundle", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    put(dirname(dir), "outside.jpg", JPEG);
    writeEvidence(dir, ["../outside.jpg"]);
    expect(stillsOf(loadEvidence(dir, out))).toEqual([null]);
  });

  it("refuses a still reached through a symlinked directory", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    put(dirname(dir), "elsewhere/x.jpg", JPEG);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dirname(dir), "elsewhere"), join(dir, "link"));
    writeEvidence(dir, ["link/x.jpg"]);
    expect(stillsOf(loadEvidence(dir, out))).toEqual([null]);
  });

  it("refuses a still over the per-still size limit", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    put(dir, "j1/big.jpg", Buffer.concat([JPEG, Buffer.alloc(64)]));
    writeEvidence(dir, ["j1/big.jpg"]);
    expect(stillsOf(loadEvidence(dir, out, { stillBytes: 32, mediaBytes: 1024 }))).toEqual([null]);
  });

  it("fails the build when total media exceeds the site budget", () => {
    const { dir, out } = bundle();
    const paths = ["j1/a.jpg", "j1/b.jpg", "j1/c.jpg"];
    for (const p of paths) put(dir, p, JPEG);
    writeEvidence(dir, paths);
    const limits = { stillBytes: 1024, mediaBytes: JPEG.length * 2 };
    expect(() => loadEvidence(dir, out, limits)).toThrow(/exceeds/);
  });

  it("uses the spec 20 limits by default: 2 MiB per still, 100 MB in total", () => {
    expect(MAX_STILL_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_MEDIA_BYTES).toBe(100 * 1024 * 1024);
  });

  it("refuses the whole bundle when it is PII-shaped", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = bundle();
    writeEvidence(dir, [null]);
    const file = join(dir, "journey-evidence.json");
    const e = JSON.parse(readFileSync(file, "utf8")) as JourneyEvidence;
    const j = e.journeys[0];
    if (j) j.title = "call 415-555-0134";
    writeFileSync(file, JSON.stringify(e));
    expect(loadEvidence(dir, out)).toBeUndefined();
  });
});
