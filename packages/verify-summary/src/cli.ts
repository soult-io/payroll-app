#!/usr/bin/env node
/**
 * Spec 17 §2 — emit the verify summary.
 *
 * Reads the suites' json reporter files, assembles the summary, runs the PII
 * guard, and writes `summary.json`. A suite whose reporter file is absent or
 * unparseable is simply omitted — so even a catastrophic run still produces a
 * summary, and a missing REQUIRED suite makes the overall status `failed`.
 *
 * Usage:
 *   verify-summary --source ci --out verify-artifacts/summary.json \
 *     --vitest engine=verify-artifacts/vitest-engine.json \
 *     --vitest server=verify-artifacts/vitest-server.json \
 *     --playwright e2e=verify-artifacts/playwright.json \
 *     --require engine,server,e2e
 *
 * Metadata comes from the environment (GITHUB_SHA / GITHUB_REF / GITHUB_RUN_ID).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSummary,
  fromPlaywrightReport,
  fromVitestReport,
  type SuiteMeta,
  type SummaryMeta,
} from "./aggregate.js";
import { assertPiiFree } from "./pii-guard.js";
import {
  type Source,
  type SuiteKey,
  type SuiteResult,
  type VerifySummary,
  sourceSchema,
  suiteKeySchema,
} from "./schema.js";

const SUITE_NAMES: Record<SuiteKey, string> = {
  engine: "Engine unit tests",
  server: "Server integration tests",
  e2e: "Playwright journeys",
};

type Kind = "vitest" | "playwright";
interface SuiteInput {
  kind: Kind;
  key: SuiteKey;
  file: string;
}

interface CliArgs {
  source: Source;
  out: string;
  inputs: SuiteInput[];
  requiredSuiteKeys: SuiteKey[];
}

function parseSuiteArg(kind: Kind, value: string): SuiteInput {
  const eq = value.indexOf("=");
  if (eq < 0) throw new Error(`--${kind} expects <key>=<file>, got "${value}"`);
  const key = suiteKeySchema.parse(value.slice(0, eq));
  return { kind, key, file: value.slice(eq + 1) };
}

function parseRequire(value: string): SuiteKey[] {
  return value ? value.split(",").map((k) => suiteKeySchema.parse(k.trim())) : [];
}

function applyFlag(args: CliArgs, flag: string | undefined, value: string): void {
  if (flag === "--source") args.source = sourceSchema.parse(value);
  else if (flag === "--out") args.out = value;
  else if (flag === "--vitest") args.inputs.push(parseSuiteArg("vitest", value));
  else if (flag === "--playwright") args.inputs.push(parseSuiteArg("playwright", value));
  else if (flag === "--require") args.requiredSuiteKeys = parseRequire(value);
}

// Every recognized flag takes a value, so args come in --flag <value> pairs.
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    source: "ci",
    out: "verify-artifacts/summary.json",
    inputs: [],
    requiredSuiteKeys: [],
  };
  for (let i = 0; i < argv.length; i += 2) {
    applyFlag(args, argv[i], argv[i + 1] ?? "");
  }
  return args;
}

export function readJson(file: string): unknown {
  if (!existsSync(file)) {
    console.warn(`verify-summary: reporter file absent, omitting suite: ${file}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(
      `verify-summary: reporter file unparseable, omitting suite: ${file} (${String(err)})`,
    );
    return undefined;
  }
}

export function loadSuite(input: SuiteInput): SuiteResult | undefined {
  const raw = readJson(input.file);
  if (raw === undefined) return undefined;
  const meta: SuiteMeta = { key: input.key, name: SUITE_NAMES[input.key] };
  return input.kind === "vitest" ? fromVitestReport(raw, meta) : fromPlaywrightReport(raw, meta);
}

export function run(argv: string[]): VerifySummary {
  const args = parseArgs(argv);
  const suites = args.inputs.map(loadSuite).filter((s): s is SuiteResult => s !== undefined);

  const meta: SummaryMeta = {
    runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
    source: args.source,
    gitSha: process.env.GITHUB_SHA ?? "unknown",
    gitRef: process.env.GITHUB_REF ?? "unknown",
    generatedAt: new Date().toISOString(),
    ...(args.requiredSuiteKeys.length > 0 ? { requiredSuiteKeys: args.requiredSuiteKeys } : {}),
  };

  const summary = buildSummary(suites, meta);
  assertPiiFree(summary);

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(
    `verify-summary: ${summary.overallStatus} — ${summary.counts.passed}/${summary.counts.total} passed across ${summary.suites.length} suite(s) → ${args.out}`,
  );
  return summary;
}

// Run only when invoked directly (node dist/cli.js / tsx src/cli.ts), never on
// import — so the helpers above stay unit-testable.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2));
}
