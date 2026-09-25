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
 * Usage:
 *   verify-site --history history --out dist [--report-href report/] [--evidence dir]
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
  type StillRecord,
  type VerifySummary,
} from "@payroll/verify-summary";
import { renderPage } from "./lib.js";
import type { EvidenceIndex, ServedJourney, ServedStill } from "./media.js";

interface GenerateArgs {
  history: string;
  out: string;
  reportHref: string | undefined;
  evidence: string | undefined;
}

function parseArgs(argv: string[]): GenerateArgs {
  const args: GenerateArgs = {
    history: "history",
    out: "dist",
    reportHref: undefined,
    evidence: undefined,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1] ?? "";
    if (flag === "--history") args.history = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--report-href") args.reportHref = value;
    else if (flag === "--evidence") args.evidence = value;
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
/** Where copied media lives in the site, per source. */
const MEDIA_DIR = "media/ci";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWithJpegMagic(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(JPEG_MAGIC.length);
    const n = readSync(fd, head, 0, head.length, 0);
    return n === head.length && JPEG_MAGIC.every((b, i) => head[i] === b);
  } finally {
    closeSync(fd);
  }
}

/**
 * Why a still cannot be served, or undefined when it can. The path must stay
 * inside the bundle and name a regular file (no symlink), within the size
 * limit, that really is a JPEG.
 */
/** A relative path that leaves its base (exact: "..foo.jpg" is a fine name). */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export interface MediaLimits {
  stillBytes: number;
  mediaBytes: number;
}

const LIMITS: MediaLimits = { stillBytes: MAX_STILL_BYTES, mediaBytes: MAX_MEDIA_BYTES };

export function stillProblem(
  bundleDir: string,
  still: StillRecord,
  maxBytes: number = MAX_STILL_BYTES,
): string | undefined {
  const abs = resolve(bundleDir, still.path);
  const rel = relative(bundleDir, abs);
  if (rel === "" || escapes(rel)) return "path escapes the bundle";
  // nginx types a file by its extension: only a .jpg/.jpeg name is served as
  // the image the magic bytes below prove it to be.
  if (!/\.jpe?g$/i.test(still.path)) return "not a .jpg name";
  if (!existsSync(abs)) return "file missing";
  const st = lstatSync(abs);
  if (!st.isFile()) return "not a regular file";
  // A symlinked DIRECTORY on the way can still lead outside: check the real path.
  const realRel = relative(realpathSync(bundleDir), realpathSync(abs));
  if (escapes(realRel)) return "path escapes the bundle";
  if (st.size > maxBytes) return `over ${maxBytes} bytes`;
  if (!startsWithJpegMagic(abs)) return "not a JPEG";
  return undefined;
}

function servedHref(relPath: string): string {
  return [...MEDIA_DIR.split("/"), ...relPath.split("/")].map(encodeURIComponent).join("/");
}

export interface LoadedEvidence {
  index: EvidenceIndex;
  /** Stills refused at validation (their steps show "no screen"). */
  refused: number;
  bytes: number;
}

/**
 * Load, validate and copy a journey-evidence bundle into `<out>/media/ci/`.
 *
 * undefined when there is no bundle, or it is invalid / PII-shaped (the whole
 * bundle is refused, and the cards say "no evidence"). A still that fails
 * validation becomes a null step, with a warning. Media over the site budget
 * THROWS: the build fails rather than publish a partial or oversized site.
 */
export function loadEvidence(
  bundleDir: string,
  outDir: string,
  limits: MediaLimits = LIMITS,
): LoadedEvidence | undefined {
  const file = join(bundleDir, "journey-evidence.json");
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`verify-site: skipping unparseable evidence ${file} (${String(err)})`);
    return undefined;
  }
  const evidence = parseEvidence(raw);
  if (!evidence) {
    console.warn(`verify-site: skipping evidence ${file} — invalid or PII-shaped`);
    return undefined;
  }
  const root = resolve(bundleDir);
  let bytes = 0;
  let refused = 0;
  const journeys = new Map<string, ServedJourney>();
  for (const j of evidence.journeys) {
    const steps = j.steps.map((step) => {
      const still = step.screenshot;
      let served: ServedStill | null = null;
      if (still) {
        const problem = stillProblem(root, still, limits.stillBytes);
        if (problem) {
          console.warn(`verify-site: refusing still ${still.path} — ${problem}`);
          refused += 1;
        } else {
          const src = resolve(root, still.path);
          bytes += lstatSync(src).size;
          if (bytes > limits.mediaBytes) {
            throw new Error(`verify-site: journey media exceeds ${limits.mediaBytes} bytes`);
          }
          const dest = join(outDir, MEDIA_DIR, still.path);
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
          served = {
            href: servedHref(still.path),
            width: still.width,
            height: still.height,
            truncated: still.truncated,
          };
        }
      }
      return { title: step.title, status: step.status, still: served };
    });
    journeys.set(j.fullName, { attempt: j.attempt, steps });
  }
  return {
    index: { runId: evidence.runId, commitSha: evidence.commitSha, journeys },
    refused,
    bytes,
  };
}

export function run(argv: string[]): { count: number; out: string } {
  const args = parseArgs(argv);
  const history = loadHistory(args.history);
  const evidence = args.evidence ? loadEvidence(args.evidence, args.out) : undefined;
  if (evidence) {
    console.log(
      `verify-site: evidence run ${evidence.index.runId} @ ${evidence.index.commitSha} — ${evidence.index.journeys.size} journey(s), ${evidence.bytes} bytes of stills, ${evidence.refused} refused`,
    );
  }
  const html = renderPage(history.summaries, {
    reportHref: args.reportHref,
    skippedSummaries: history.skipped,
    evidence: evidence?.index,
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
