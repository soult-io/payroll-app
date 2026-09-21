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
import { findPii, type VerifySummary, verifySummarySchema } from "@payroll/verify-summary";
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
export function loadHistory(dir: string): VerifySummary[] {
  if (!existsSync(dir)) return [];
  const summaries: VerifySummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`verify-site: skipping unparseable ${path} (${String(err)})`);
      continue;
    }
    const parsed = verifySummarySchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`verify-site: skipping invalid summary ${path}`);
      continue;
    }
    // Fail closed on the offending FILE, not the whole render: one poisoned
    // history file must never brick every future build (it stays on the data
    // branch). Skip + warn instead of throwing, so PII is never rendered.
    const pii = findPii(parsed.data);
    if (pii.length > 0) {
      console.warn(
        `verify-site: skipping ${path} — ${pii.length} PII-shaped value(s), e.g. ${pii[0]?.kind}`,
      );
      continue;
    }
    summaries.push(parsed.data);
  }
  return summaries;
}

export function run(argv: string[]): { count: number; out: string } {
  const args = parseArgs(argv);
  const history = loadHistory(args.history);
  const html = renderPage(history, { reportHref: args.reportHref });
  mkdirSync(args.out, { recursive: true });
  const out = join(args.out, "index.html");
  writeFileSync(out, html, "utf8");
  console.log(`verify-site: rendered ${history.length} run(s) → ${out}`);
  return { count: history.length, out };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2));
}
