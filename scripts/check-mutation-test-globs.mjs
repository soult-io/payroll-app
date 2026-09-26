#!/usr/bin/env node
// PAY-108 guard: every server test suite that imports a mutation-tested
// module (src/deposits, src/filings) must match that target's `testFiles`
// globs in apps/server/stryker.targets.mjs. A suite left out is never run
// against the mutants, and the score drops with no error — this happened with
// the seven PAY-91 deposit suites. Runs in the CI verify job.
//
// Usage: node scripts/check-mutation-test-globs.mjs   (exit 1 on a gap)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "../apps/server/stryker.targets.mjs";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/server");
const TEST_DIR = resolve(SERVER, "test");

const suites = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

let gaps = 0;
for (const [name, target] of Object.entries(TARGETS)) {
  // Static or dynamic import of ../src/<module>/… (any quote style).
  const importRe = new RegExp(`["'\`]\\.\\./src/${name}/`);
  const importers = suites.filter((f) => importRe.test(readFileSync(resolve(TEST_DIR, f), "utf8")));
  const missing = importers.filter(
    (f) => !target.testFiles.some((glob) => matchesGlob(`test/${f}`, glob)),
  );
  for (const f of missing) {
    console.error(
      `✗ apps/server/test/${f} imports src/${name} but matches no "${name}" testFiles glob ` +
        "in apps/server/stryker.targets.mjs — add a glob (or rename the suite).",
    );
  }
  gaps += missing.length;
  console.log(`${name}: ${importers.length} importing suite(s), ${missing.length} not covered`);
}

if (gaps > 0) process.exit(1);
