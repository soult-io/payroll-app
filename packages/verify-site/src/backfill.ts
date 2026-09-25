#!/usr/bin/env node
/**
 * Spec 21 (PAY-79) — which completed runs the history is missing.
 *
 * pay-verify-site serializes its publishing runs in one concurrency group, and
 * GitHub keeps only ONE pending run per group: a third arrival cancels the
 * pending one, so that run's summary is never ingested and nothing says so.
 * Before ingesting, each publishing run asks this planner which completed ci /
 * nightly runs on main have no history file, and ingests those too.
 *
 * Pure planning plus a thin CLI; the workflow does the downloading.
 *
 * Usage:
 *   backfill --history <dir> --runs <runs.json> [--exclude <runId>]
 * Prints one tab-separated line per run to fetch: `<runId>\t<artifact>\t<file>\t<headSha>`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A completed workflow run, as the Actions API lists it. */
export interface RunInfo {
  id: string;
  workflow: "ci" | "e2e-nightly";
  event: string;
  conclusion: string | null;
  headBranch: string;
  headSha: string;
  /** ISO instant the run last changed (completed). */
  updatedAt: string;
}

export interface BackfillItem {
  runId: string;
  artifact: string;
  /** History file name: `<compact instant>-<runId>.json`, sorting chronologically. */
  file: string;
  headSha: string;
}

/**
 * Events whose runs feed the site, per workflow. Deliberately NARROWER than the
 * site workflow's own gate (which accepts push / schedule / workflow_dispatch
 * for any non-walkthrough workflow): only the events each workflow actually
 * runs on main. Keep in step with pay-verify-site.yml's job `if`.
 */
const FEEDING_EVENTS: Record<RunInfo["workflow"], readonly string[]> = {
  ci: ["push", "workflow_dispatch"],
  "e2e-nightly": ["schedule", "workflow_dispatch"],
};

/** Same names as pay-verify-site.yml's "Download summary artifact" step. */
const ARTIFACT: Record<RunInfo["workflow"], string> = {
  ci: "pay-verify-summary",
  "e2e-nightly": "pay-verify-summary-nightly",
};

/**
 * History file names are `<YYYYMMDDTHHMMSSZ>-<runId>.json` — the same form the
 * workflow's "Ingest summary" step writes and globs (`*-<runId>.json`).
 */
const INSTANT_LENGTH = "YYYYMMDDTHHMMSSZ".length;

/** A history file name's instant, e.g. `20260925T130819Z`. */
function instantOf(file: string): string {
  return file.slice(0, INSTANT_LENGTH);
}

/** A history file name's run id, or undefined for a file that is not one. */
export function runIdOf(file: string): string | undefined {
  return /-(\d+)\.json$/.exec(file)?.[1];
}

/** `2026-09-25T13:08:19Z` → `20260925T130819Z`, the history files' instant form. */
export function compactInstant(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * A run that fed the site a result: on main, from an event that workflow runs
 * on, and finished having tested something (a failure is a result; a
 * cancelled or skipped run is not).
 */
function fedAResult(run: RunInfo): boolean {
  if (run.headBranch !== "main") return false;
  if (!FEEDING_EVENTS[run.workflow].includes(run.event)) return false;
  return run.conclusion !== null && run.conclusion !== "cancelled" && run.conclusion !== "skipped";
}

/**
 * The runs to backfill: completed, fed-to-the-site runs on main with no
 * history file, newer than the oldest retained history entry (an older one
 * would be pruned straight away — and would resurrect a run the window already
 * let go). A cancelled or skipped run tested nothing and is never backfilled.
 * `exclude` is the triggering run, which the normal ingest step handles.
 */
export function planBackfill(
  historyFiles: readonly string[],
  runs: readonly RunInfo[],
  exclude?: string,
): BackfillItem[] {
  const have = new Set(historyFiles.map(runIdOf).filter((id): id is string => id !== undefined));
  const oldest = [...historyFiles].sort()[0];
  const windowStart = oldest === undefined ? undefined : instantOf(oldest);
  const out: BackfillItem[] = [];
  for (const run of runs) {
    if (run.id === exclude || have.has(run.id) || !fedAResult(run)) continue;
    const at = compactInstant(run.updatedAt);
    if (!at || (windowStart && at < windowStart)) continue;
    out.push({
      runId: run.id,
      artifact: ARTIFACT[run.workflow],
      file: `${at}-${run.id}.json`,
      headSha: run.headSha,
    });
    have.add(run.id);
  }
  // Plain code-unit order: the names are ASCII and sort chronologically.
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function runCli(argv: string[]): string {
  const history = arg(argv, "--history") ?? "history";
  const runsFile = arg(argv, "--runs");
  if (!runsFile) throw new Error("backfill: --runs <file> is required");
  let files: string[] = [];
  try {
    files = readdirSync(history).filter((f) => f.endsWith(".json"));
  } catch (err) {
    // No history yet: nothing to compare against, and no window to respect.
    // Anything else is a real failure (the workflow turns it into a warning).
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const runs = JSON.parse(readFileSync(runsFile, "utf8")) as RunInfo[];
  return planBackfill(files, runs, arg(argv, "--exclude"))
    .map((i) => `${i.runId}\t${i.artifact}\t${i.file}\t${i.headSha}`)
    .join("\n");
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const out = runCli(process.argv.slice(2));
  if (out) console.log(out);
}
