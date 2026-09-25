#!/usr/bin/env node
/**
 * Spec 17 chunk B — generate the static pay-verify dashboard.
 *
 * Reads every `*.json` in the history dir, validates each against the
 * verify-summary schema (skipping invalid ones), re-asserts PII-free as
 * defense-in-depth, renders the dashboard, and writes `<out>/index.html`.
 * An absent/empty history dir yields the "awaiting first run" page.
 *
 * Spec 20 (PAY-78): with `--evidence <dir>` it also loads the journey-evidence
 * bundle (journey-evidence.json + step stills), validates every still, copies
 * the valid ones to `<out>/media/ci/`, and hands the index to the renderer.
 *
 * With `--walkthrough <dir>` it also loads the human-pace walkthrough bundle
 * (walkthrough-evidence.json + one webm per journey), validates every video,
 * and copies the valid ones to `<out>/media/walkthrough/`.
 *
 * Usage:
 *   verify-site --history history --out dist [--report-href report/]
 *               [--evidence dir] [--walkthrough dir] [--run-url-base url]
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findPii,
  parseEvidence,
  parseSummary,
  parseWalkthrough,
  type StillRecord,
  type VerifySummary,
} from "@payroll/verify-summary";
import { renderPage } from "./lib.js";
import type {
  EvidenceIndex,
  ServedJourney,
  ServedStill,
  ServedWalkthrough,
  WalkthroughIndex,
} from "./media.js";

interface GenerateArgs {
  history: string;
  out: string;
  reportHref: string | undefined;
  evidence: string | undefined;
  walkthrough: string | undefined;
  runUrlBase: string | undefined;
}

function parseArgs(argv: string[]): GenerateArgs {
  const args: GenerateArgs = {
    history: "history",
    out: "dist",
    reportHref: undefined,
    evidence: undefined,
    walkthrough: undefined,
    runUrlBase: undefined,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1] ?? "";
    if (flag === "--history") args.history = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--report-href") args.reportHref = value;
    else if (flag === "--evidence") args.evidence = value;
    else if (flag === "--walkthrough") args.walkthrough = value;
    else if (flag === "--run-url-base") args.runUrlBase = value;
  }
  return args;
}

/** Read + validate every summary in the history dir (invalid ones are skipped). */
export interface History {
  summaries: VerifySummary[];
  /** Files present but unreadable — reported in the page footer, not just the log. */
  skipped: number;
}

export function loadHistory(dir: string): History {
  if (!existsSync(dir)) return { summaries: [], skipped: 0 };
  const summaries: VerifySummary[] = [];
  let skipped = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`verify-site: skipping unparseable ${path} (${String(err)})`);
      skipped += 1;
      continue;
    }
    // parseSummary, not the v2 schema directly: the retained history window is
    // still entirely v1 and must keep rendering (spec 18 §Back-compat).
    const parsed = parseSummary(raw);
    if (!parsed) {
      console.warn(`verify-site: skipping invalid summary ${path}`);
      skipped += 1;
      continue;
    }
    // Fail closed on the offending FILE, not the whole render: one poisoned
    // history file must never brick every future build (it stays on the data
    // branch). Skip + warn instead of throwing, so PII is never rendered.
    const pii = findPii(parsed);
    if (pii.length > 0) {
      console.warn(
        `verify-site: skipping ${path} — ${pii.length} PII-shaped value(s), e.g. ${pii[0]?.kind}`,
      );
      skipped += 1;
      continue;
    }
    summaries.push(parsed);
  }
  return { summaries, skipped };
}

/** Spec 20 limits: one still, and all media the site may carry. */
export const MAX_STILL_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** Spec 20 limit for one walkthrough video. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
/** Where copied media lives in the site, per source. */
const MEDIA_DIR = "media/ci";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** EBML header: every WebM file starts with it. */
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

function startsWith(path: string, magic: readonly number[]): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(magic.length);
    const n = readSync(fd, head, 0, head.length, 0);
    return n === head.length && magic.every((b, i) => head[i] === b);
  } finally {
    closeSync(fd);
  }
}

/** A relative path that leaves its base (exact: "..foo.jpg" is a fine name). */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

interface MediaLimits {
  stillBytes: number;
  mediaBytes: number;
}

const LIMITS: MediaLimits = { stillBytes: MAX_STILL_BYTES, mediaBytes: MAX_MEDIA_BYTES };

type FileCheck = { ok: true; size: number } | { ok: false; reason: string };

/** What a served media file must be: its extension and its leading bytes. */
interface MediaKind {
  name: RegExp;
  magic: readonly number[];
  label: string;
}
const JPEG: MediaKind = { name: /\.jpe?g$/i, magic: JPEG_MAGIC, label: "JPEG" };
const WEBM: MediaKind = { name: /\.webm$/i, magic: WEBM_MAGIC, label: "WebM" };

/**
 * Can this bundle file be served? The path must stay inside the bundle (also
 * by real path), carry the kind's extension (nginx types a file by it), and
 * name a regular file (no symlink) within the size limit whose leading bytes
 * prove the kind. On success, its size.
 */
function checkFile(root: string, path: string, kind: MediaKind, maxBytes: number): FileCheck {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === "" || escapes(rel)) return { ok: false, reason: "path escapes the bundle" };
  if (!kind.name.test(path)) return { ok: false, reason: `not a ${kind.label} name` };
  if (!existsSync(abs)) return { ok: false, reason: "file missing" };
  const st = lstatSync(abs);
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  // A symlinked DIRECTORY on the way can still lead outside: check the real path.
  if (escapes(relative(realpathSync(root), realpathSync(abs)))) {
    return { ok: false, reason: "path escapes the bundle" };
  }
  if (st.size > maxBytes) return { ok: false, reason: `over ${maxBytes} bytes` };
  if (!startsWith(abs, kind.magic)) return { ok: false, reason: `not a ${kind.label}` };
  return { ok: true, size: st.size };
}

function servedHref(mediaDir: string, relPath: string): string {
  return [...mediaDir.split("/"), ...relPath.split("/")].map(encodeURIComponent).join("/");
}

/**
 * A bundle's JSON file, parsed by `parse`; undefined (with a warning naming
 * `what`) when absent, unparseable, or refused by the parser.
 */
function readBundleFile<T>(
  file: string,
  what: string,
  parse: (raw: unknown) => T | undefined,
): T | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`verify-site: skipping unparseable ${what} ${file} (${String(err)})`);
    return undefined;
  }
  const parsed = parse(raw);
  if (!parsed)
    console.warn(`verify-site: skipping ${what} ${file} — refused (invalid or PII-shaped)`);
  return parsed;
}

interface CopyTally {
  bytes: number;
  refused: number;
}

/**
 * Validate one bundle file as `kind` and copy it into `<out>/<mediaDir>/`;
 * its served href, or null when refused (with a warning). Media over the site
 * budget THROWS: the build fails rather than publish a partial or oversized
 * site. The one place the budget rule lives, for stills and videos alike.
 */
function serveFile(
  root: string,
  outDir: string,
  mediaDir: string,
  path: string,
  kind: MediaKind,
  maxBytes: number,
  limits: MediaLimits,
  tally: CopyTally,
): string | null {
  const check = checkFile(root, path, kind, maxBytes);
  if (!check.ok) {
    console.warn(`verify-site: refusing ${kind.label} ${path} — ${check.reason}`);
    tally.refused += 1;
    return null;
  }
  tally.bytes += check.size;
  if (tally.bytes > limits.mediaBytes) {
    throw new Error(`verify-site: journey media exceeds ${limits.mediaBytes} bytes`);
  }
  const dest = join(outDir, mediaDir, path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(root, path), dest);
  return servedHref(mediaDir, path);
}

function serveStill(
  root: string,
  outDir: string,
  still: StillRecord,
  limits: MediaLimits,
  tally: CopyTally,
): ServedStill | null {
  const href = serveFile(
    root,
    outDir,
    MEDIA_DIR,
    still.path,
    JPEG,
    limits.stillBytes,
    limits,
    tally,
  );
  return href
    ? { href, width: still.width, height: still.height, truncated: still.truncated }
    : null;
}

interface LoadedEvidence extends CopyTally {
  index: EvidenceIndex;
}

/**
 * Load, validate and copy a journey-evidence bundle into `<out>/media/ci/`.
 *
 * undefined when there is no bundle, or it is invalid / PII-shaped (the whole
 * bundle is refused, and the cards say "no evidence"). A still that fails
 * validation becomes a null step, with a warning.
 */
export function loadEvidence(
  bundleDir: string,
  outDir: string,
  limits: MediaLimits = LIMITS,
): LoadedEvidence | undefined {
  const evidence = readBundleFile(
    join(bundleDir, "journey-evidence.json"),
    "evidence",
    parseEvidence,
  );
  if (!evidence) return undefined;
  const root = resolve(bundleDir);
  const tally: CopyTally = { bytes: 0, refused: 0 };
  const journeys = new Map<string, ServedJourney>();
  for (const j of evidence.journeys) {
    const steps = j.steps.map((step) => ({
      title: step.title,
      status: step.status,
      still: step.screenshot ? serveStill(root, outDir, step.screenshot, limits, tally) : null,
    }));
    journeys.set(j.fullName, { attempt: j.attempt, steps });
  }
  return { index: { runId: evidence.runId, commitSha: evidence.commitSha, journeys }, ...tally };
}

/** Where copied walkthrough videos live in the site. */
const WALKTHROUGH_DIR = "media/walkthrough";

/**
 * Load, validate and copy a walkthrough bundle into `<out>/media/walkthrough/`.
 * Videos count against the same site budget as the stills (`tally`), and over
 * it the build fails. A video that fails validation is dropped (its journey
 * gets no Video tab).
 */
export function loadWalkthrough(
  bundleDir: string,
  outDir: string,
  tally: CopyTally = { bytes: 0, refused: 0 },
  limits: MediaLimits & { videoBytes: number } = { ...LIMITS, videoBytes: MAX_VIDEO_BYTES },
): WalkthroughIndex | undefined {
  const evidence = readBundleFile(
    join(bundleDir, "walkthrough-evidence.json"),
    "walkthrough",
    parseWalkthrough,
  );
  if (!evidence) return undefined;
  const root = resolve(bundleDir);
  const journeys = new Map<string, ServedWalkthrough>();
  for (const j of evidence.journeys) {
    if (!j.video) continue;
    const href = serveFile(
      root,
      outDir,
      WALKTHROUGH_DIR,
      j.video.path,
      WEBM,
      limits.videoBytes,
      limits,
      tally,
    );
    if (!href) continue;
    journeys.set(j.fullName, {
      href,
      durationMs: j.video.durationMs,
      steps: j.steps.map((s) => ({ title: s.title, offsetMs: s.offsetMs })),
    });
  }
  return {
    commitSha: evidence.commitSha,
    gatingRunId: evidence.gatingRunId,
    runId: evidence.runId,
    journeys,
  };
}

export function run(argv: string[]): { count: number; out: string } {
  const args = parseArgs(argv);
  const history = loadHistory(args.history);
  const evidence = args.evidence ? loadEvidence(args.evidence, args.out) : undefined;
  // One budget for all media: the videos count on top of the stills.
  const tally: CopyTally = { bytes: evidence?.bytes ?? 0, refused: 0 };
  const walkthrough = args.walkthrough
    ? loadWalkthrough(args.walkthrough, args.out, tally)
    : undefined;
  if (walkthrough) {
    console.log(
      `verify-site: walkthrough run ${walkthrough.runId} of ${walkthrough.commitSha} (gating run ${walkthrough.gatingRunId}) — ${walkthrough.journeys.size} video(s), ${tally.refused} refused`,
    );
  }
  if (evidence) {
    console.log(
      `verify-site: evidence run ${evidence.index.runId} @ ${evidence.index.commitSha} — ${evidence.index.journeys.size} journey(s), ${evidence.bytes} bytes of stills, ${evidence.refused} refused`,
    );
  }
  const html = renderPage(history.summaries, {
    reportHref: args.reportHref,
    skippedSummaries: history.skipped,
    evidence: evidence?.index,
    walkthrough,
    runUrlBase: args.runUrlBase,
  });
  mkdirSync(args.out, { recursive: true });
  const out = join(args.out, "index.html");
  writeFileSync(out, html, "utf8");
  console.log(
    `verify-site: rendered ${history.summaries.length} run(s), skipped ${history.skipped} → ${out}`,
  );
  return { count: history.summaries.length, out };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2));
}
