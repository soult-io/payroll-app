/**
 * Walkthrough reporter (spec 20, PAY-78).
 *
 * Registered only in walkthrough mode (E2E_WALKTHROUGH=1). For every journey
 * test it joins the recorded clips into ONE webm (walkthrough-plan.ts says
 * how), and writes `walkthrough-evidence.json` (schema `journey-walkthrough/1`):
 * each journey's video plus each step's offset into it.
 *
 * Bound to the gating run it re-records: `commitSha` is the TESTED commit and
 * `gatingRunId` the ci run that gated it (WALKTHROUGH_COMMIT_SHA /
 * WALKTHROUGH_GATING_RUN_ID, set by walkthrough.yml — under workflow_run,
 * GITHUB_SHA is main's tip, not the tested commit). `runId` is this recording's
 * own run. The site can then refuse a recording of another commit or run.
 *
 * Needs `ffmpeg` and `ffprobe` on PATH (the CI walkthrough job installs them).
 * A journey whose clips cannot be measured or joined gets `video: null` and a
 * logged reason — never a partial or mislabelled video.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import {
  CLIP_MARK_ANNOTATION,
  type ClipMark,
  STEP_MARK_ANNOTATION,
  type StepMark,
  VIDEO_SIZE,
} from "../tests/support/walkthrough.js";
import { JOURNEY_FILES, type JourneyStatus, journeyStatus } from "./evidence-reporter.js";
import { CARD_MS, type MeasuredClip, planStitch, type Segment } from "./walkthrough-plan.js";

export const WALKTHROUGH_SCHEMA = "journey-walkthrough/1";

interface WalkthroughStep {
  title: string;
  status: "passed" | "failed";
  /** Start of the step in the journey's video (ms); null when not placeable. */
  offsetMs: number | null;
}

interface WalkthroughJourney {
  testId: string;
  fullName: string;
  title: string;
  file: string;
  status: JourneyStatus;
  video: { path: string; contentType: "video/webm"; durationMs: number } | null;
  steps: WalkthroughStep[];
}

interface WalkthroughEvidence {
  schema: typeof WALKTHROUGH_SCHEMA;
  mode: "walkthrough";
  commitSha: string;
  /** The ci run whose gating result this recording sits beside; null off main. */
  gatingRunId: string | null;
  runId: string;
  source: "ci";
  generatedAt: string;
  journeys: WalkthroughJourney[];
}

function marks<T>(result: TestResult, type: string): T[] {
  return result.annotations
    .filter((a) => a.type === type && a.description)
    .map((a) => JSON.parse(a.description as string) as T);
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Duration of a media file (ms), or NaN when ffprobe cannot tell. */
function durationMs(file: string): number {
  const probe = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const secs = Number.parseFloat(probe.out.trim());
  if (probe.ok && Number.isFinite(secs)) return Math.round(secs * 1000);
  // Some recorder outputs carry no duration header: decode to find the end.
  const decoded = run("ffmpeg", ["-v", "info", "-i", file, "-f", "null", "-"]);
  const times = [...decoded.out.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (!last) return Number.NaN;
  return Math.round(
    (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number.parseFloat(last[3] ?? "0")) * 1000,
  );
}

/** Render a title / caption card as a short clip, with Playwright's own browser. */
async function renderCard(text: string, dir: string, n: number): Promise<string> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: VIDEO_SIZE,
      recordVideo: { dir, size: VIDEO_SIZE },
    });
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1f2937;color:#f9fafb;font:600 40px system-ui,sans-serif;text-align:center;padding:0 80px"><div id="t"></div></body>`,
    );
    await page.locator("#t").evaluate((el, t) => {
      el.textContent = t;
    }, text);
    await page.waitForTimeout(CARD_MS + 400);
    const video = page.video();
    await ctx.close();
    const path = await video?.path();
    if (!path) throw new Error("card was not recorded");
    const named = join(dir, `card-${String(n).padStart(2, "0")}.webm`);
    renameSync(path, named);
    return named;
  } finally {
    await browser.close();
  }
}

/** Join the planned segments into one webm. Re-encodes: clips are cut mid-stream. */
async function stitch(segments: Segment[], out: string, workDir: string): Promise<boolean> {
  const inputs: string[] = [];
  let n = 0;
  for (const seg of segments) {
    if (seg.kind === "clip") {
      inputs.push("-ss", (seg.fromMs / 1000).toFixed(3), "-t", (seg.durationMs / 1000).toFixed(3));
      inputs.push("-i", seg.video);
    } else {
      const card = await renderCard(seg.text, workDir, n);
      // The LAST stretch of the card clip: its first frames are the blank page
      // before the card is drawn. Measured, not -sseof: a recording may carry
      // no duration header.
      const cardMs = durationMs(card);
      if (!Number.isFinite(cardMs)) return false;
      const from = Math.max(0, cardMs - seg.durationMs) / 1000;
      inputs.push("-ss", from.toFixed(3), "-t", (seg.durationMs / 1000).toFixed(3), "-i", card);
    }
    n += 1;
  }
  const norm = segments
    .map(
      (_, i) =>
        `[${i}:v]scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height},setsar=1,fps=25,format=yuv420p[v${i}]`,
    )
    .join(";");
  const joined = `${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`;
  const r = run("ffmpeg", [
    "-y",
    "-v",
    "error",
    ...inputs,
    "-filter_complex",
    `${norm};${joined}`,
    "-map",
    "[out]",
    "-an",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    "1500k",
    "-crf",
    "10",
    out,
  ]);
  if (!r.ok) console.warn(`walkthrough: ffmpeg failed for ${out}\n${r.out.slice(-2000)}`);
  return r.ok;
}

/** Scene-change score above which ffmpeg counts a new screen. */
const SCENE_THRESHOLD = 0.08;

/**
 * Report-only pacing check (spec 20 wants every screen >= 1.5s). From ffmpeg's
 * scene-change detector it writes, next to the video:
 * - `pacing/<name>.json`: every detected screen with its start and length;
 * - `pacing/<name>-NN.jpg`: contact sheets of the first frame of each screen,
 *   in order, so a reader can see WHAT each short screen was (an animation
 *   step, a loading state, a real flash) without decoding the video.
 * One summary line per journey goes to the log.
 */
function pacingReport(video: string, name: string, title: string, dir: string): void {
  const pacingDir = join(dir, "pacing");
  mkdirSync(pacingDir, { recursive: true });
  // Quoted: the commas inside are part of the expression, not filter separators.
  const select = `select='eq(n,0)+gt(scene,${SCENE_THRESHOLD})'`;
  const r = run("ffmpeg", [
    "-v",
    "info",
    "-i",
    video,
    "-vf",
    `${select},showinfo`,
    "-f",
    "null",
    "-",
  ]);
  const starts = [...r.out.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const total = durationMs(video) / 1000;
  const screens = starts.map((t, i) => ({
    start: t,
    seconds: Number(((starts[i + 1] ?? total) - t).toFixed(2)),
  }));
  writeFileSync(
    join(pacingDir, `${name}.json`),
    `${JSON.stringify({ title, screens }, null, 2)}\n`,
  );
  run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    `${select},scale=320:-1,tile=4x5:padding=4:color=white`,
    "-fps_mode",
    "vfr",
    join(pacingDir, `${name}-%02d.jpg`),
  ]);
  const short = screens.filter((s) => s.seconds < 1.45).length;
  const min = screens.length ? Math.min(...screens.map((s) => s.seconds)) : 0;
  console.log(
    `walkthrough pacing · ${title}: ${screens.length} screens, shortest ${min.toFixed(2)}s, ${short} under 1.5s`,
  );
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "journey"
  );
}

export default class WalkthroughReporter implements Reporter {
  private readonly outputFile: string;
  private readonly finals = new Map<string, { test: TestCase; result: TestResult }>();

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(
      options.outputFile ?? "test-results-walkthrough/walkthrough-evidence.json",
    );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!JOURNEY_FILES.has(basename(test.location.file))) return;
    const prev = this.finals.get(test.id);
    if (!prev || result.retry >= prev.result.retry) this.finals.set(test.id, { test, result });
  }

  private async journey(
    test: TestCase,
    result: TestResult,
    dir: string,
  ): Promise<WalkthroughJourney> {
    const stepMarks = marks<StepMark>(result, STEP_MARK_ANNOTATION);
    const clipMarks = marks<ClipMark>(result, CLIP_MARK_ANNOTATION);
    const topSteps = result.steps.filter((s) => s.category === "test.step");
    const base = {
      testId: test.id,
      fullName: test.titlePath().slice(2).join(" "),
      title: test.title,
      file: basename(test.location.file),
      status: journeyStatus(test.outcome(), result.status),
    };
    const stepsWithout = (offsets?: Map<number, number | null>): WalkthroughStep[] =>
      stepMarks.map((m) => ({
        title: m.title,
        status: topSteps[m.index]?.error ? "failed" : "passed",
        offsetMs: offsets?.get(m.index) ?? null,
      }));
    if (stepMarks.length === 0) return { ...base, video: null, steps: [] };

    // With `video: on`, Playwright saves the FIXTURE page's recording as the
    // test's "video" attachment and deletes the file page.video() named. Only
    // that one clip can be missing, so it maps to the attachment.
    const fixtureVideo = result.attachments.find((a) => a.name === "video" && a.path)?.path;
    const clips: MeasuredClip[] = clipMarks.map((c) => {
      const video = existsSync(c.video) ? c.video : (fixtureVideo ?? c.video);
      const closes = existsSync(c.closeFile)
        ? (JSON.parse(readFileSync(c.closeFile, "utf8")) as Record<string, number>)
        : {};
      return {
        clip: c.clip,
        video,
        durationMs: existsSync(video) ? durationMs(video) : Number.NaN,
        closedAt: closes[String(c.clip)] ?? Number.NaN,
        startedAt: c.recordingStartedAt,
      };
    });
    const plan = planStitch(test.title, clips, stepMarks);
    if (!plan) {
      console.warn(`walkthrough: ${test.title} — a clip could not be measured; no video`);
      return { ...base, video: null, steps: stepsWithout() };
    }
    // The test id keeps two similar titles from sharing (and overwriting) a
    // file. Its TAIL: the head is the file's hash, the same for every test in it.
    const name = `${slug(test.title)}-${test.id.slice(-12)}`;
    const work = join(dir, "work", name);
    mkdirSync(work, { recursive: true });
    const out = join(dir, "videos", `${name}.webm`);
    mkdirSync(dirname(out), { recursive: true });
    if (!(await stitch(plan.segments, out, work))) {
      return { ...base, video: null, steps: stepsWithout() };
    }
    pacingReport(out, name, test.title, dir);
    const measured = durationMs(out);
    return {
      ...base,
      video: {
        path: relative(dir, out).split(sep).join("/"),
        contentType: "video/webm",
        durationMs: Number.isFinite(measured) ? measured : plan.durationMs,
      },
      steps: stepsWithout(plan.offsets),
    };
  }

  async onEnd(_result: FullResult): Promise<void> {
    const dir = dirname(this.outputFile);
    const journeys: WalkthroughJourney[] = [];
    for (const { test, result } of this.finals.values()) {
      journeys.push(await this.journey(test, result, dir));
    }
    const evidence: WalkthroughEvidence = {
      schema: WALKTHROUGH_SCHEMA,
      mode: "walkthrough",
      commitSha: process.env.WALKTHROUGH_COMMIT_SHA || process.env.GITHUB_SHA || "local",
      gatingRunId: process.env.WALKTHROUGH_GATING_RUN_ID || null,
      runId: process.env.GITHUB_RUN_ID ?? "local",
      source: "ci",
      generatedAt: new Date().toISOString(),
      journeys,
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
