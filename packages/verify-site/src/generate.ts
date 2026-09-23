#!/usr/bin/env node
/**
 * Spec 17 chunk B — generate the static pay-verify dashboard.
 *
 * Reads every `*.json` in the history dir, validates each against the
 * verify-summary schema (skipping invalid ones), re-asserts PII-free as
 * defense-in-depth, renders the dashboard, and writes `<out>/index.html`.
 * An absent/empty history dir yields the "awaiting first run" page.
 *
 * Usage:
 *   verify-site --history history --out dist [--report-href report/]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPii, parseSummary, type VerifySummary } from "@payroll/verify-summary";
import { renderPage } from "./lib.js";

interface GenerateArgs {
  history: string;
  out: string;
  reportHref: string | undefined;
}

function parseArgs(argv: string[]): GenerateArgs {
  const args: GenerateArgs = { history: "history", out: "dist", reportHref: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1] ?? "";
    if (flag === "--history") args.history = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--report-href") args.reportHref = value;
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

export function run(argv: string[]): { count: number; out: string } {
  const args = parseArgs(argv);
  const history = loadHistory(args.history);
  const html = renderPage(history.summaries, {
    reportHref: args.reportHref,
    skippedSummaries: history.skipped,
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
