import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WalkthroughEvidence } from "@payroll/verify-summary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWalkthrough, MAX_VIDEO_BYTES } from "../src/generate.js";

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);

function dirs(): { dir: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-walkthrough-"));
  return { dir: join(root, "bundle"), out: join(root, "site") };
}

function put(dir: string, rel: string, bytes: Buffer): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

function write(dir: string, videos: (string | null)[], over: Partial<WalkthroughEvidence> = {}) {
  const e: WalkthroughEvidence = {
    schema: "journey-walkthrough/1",
    mode: "walkthrough",
    commitSha: "abc1234",
    gatingRunId: "42",
    runId: "77",
    source: "ci",
    generatedAt: "2026-09-25T12:00:00.000Z",
    journeys: videos.map((v, i) => ({
      testId: `t${i}`,
      fullName: `journeys.spec.ts journey ${i}`,
      title: `journey ${i}`,
      file: "journeys.spec.ts",
      status: "passed",
      video: v === null ? null : { path: v, contentType: "video/webm", durationMs: 9000 },
      steps: [{ title: "s", status: "passed", offsetMs: 1500 }],
    })),
    ...over,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "walkthrough-evidence.json"), JSON.stringify(e));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWalkthrough", () => {
  it("returns undefined without a bundle", () => {
    const { dir, out } = dirs();
    expect(loadWalkthrough(dir, out)).toBeUndefined();
  });

  it("copies a valid WebM under media/walkthrough and keeps the step offsets", () => {
    const { dir, out } = dirs();
    put(dir, "videos/j0.webm", WEBM);
    write(dir, ["videos/j0.webm"]);
    const w = loadWalkthrough(dir, out);
    expect(w).toMatchObject({ commitSha: "abc1234", gatingRunId: "42", runId: "77" });
    expect(w?.journeys.get("journeys.spec.ts journey 0")).toEqual({
      href: "media/walkthrough/videos/j0.webm",
      durationMs: 9000,
      steps: [{ title: "s", offsetMs: 1500 }],
    });
    expect(readFileSync(join(out, "media/walkthrough/videos/j0.webm"))).toEqual(WEBM);
  });

  it("refuses a recording with no gating run (a PR or manual run is never published)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = dirs();
    put(dir, "videos/j0.webm", WEBM);
    write(dir, ["videos/j0.webm"], { gatingRunId: null });
    expect(loadWalkthrough(dir, out)).toBeUndefined();
  });

  it("drops a video that is not WebM bytes, or not a .webm name, and copies neither", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = dirs();
    put(dir, "videos/fake.webm", Buffer.from("<html>"));
    put(dir, "videos/real.html", WEBM);
    const tally = { bytes: 0, refused: 0 };
    write(dir, ["videos/fake.webm", "videos/real.html"]);
    const w = loadWalkthrough(dir, out, tally);
    expect(w?.journeys.size).toBe(0);
    expect(tally.refused).toBe(2);
    expect(existsSync(join(out, "media/walkthrough/videos/real.html"))).toBe(false);
  });

  it("drops a video over the per-video limit", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, out } = dirs();
    put(dir, "videos/big.webm", Buffer.concat([WEBM, Buffer.alloc(64)]));
    write(dir, ["videos/big.webm"]);
    const limits = { stillBytes: 1, mediaBytes: 1_000_000, videoBytes: 32 };
    expect(loadWalkthrough(dir, out, undefined, limits)?.journeys.size).toBe(0);
  });

  it("counts videos against the same budget as the stills, and fails the build over it", () => {
    const { dir, out } = dirs();
    put(dir, "videos/a.webm", WEBM);
    write(dir, ["videos/a.webm"]);
    const tally = { bytes: 95, refused: 0 }; // stills already copied
    const limits = { stillBytes: 1, mediaBytes: 100, videoBytes: 1_000 };
    expect(() => loadWalkthrough(dir, out, tally, limits)).toThrow(/exceeds/);
  });

  it("a journey with no video is simply absent (no Video tab)", () => {
    const { dir, out } = dirs();
    write(dir, [null]);
    expect(loadWalkthrough(dir, out)?.journeys.size).toBe(0);
  });

  it("uses the spec 20 per-video limit by default: 20 MB", () => {
    expect(MAX_VIDEO_BYTES).toBe(20 * 1024 * 1024);
  });
});
