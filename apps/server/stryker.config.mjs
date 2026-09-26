// Mutation testing for the money-path server modules — deposits/ and
// filings/ (PAY-93). Run with `pnpm mutation:server` from the repo root; see
// CONTRIBUTING.md. Uses the normal PGlite integration tests. The HTML report
// holds only source code and mutant diffs — no env, no data.
//
// Needs the workspace packages built first — the server imports @payroll/*
// from their dist/. `pnpm mutation:server` builds them.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/deposits/**/*.ts", "src/filings/**/*.ts"],
  // Only the suites that exercise deposits/filings. Each file boots its own
  // PGlite, so running all 38 files per mutant would add hours for no signal.
  testFiles: [
    "test/deposits.test.ts",
    "test/deposit-attachments.test.ts",
    "test/filings.test.ts",
    "test/filing-attachments.test.ts",
    "test/filing-recompute.test.ts",
    "test/annual-forms.test.ts",
    "test/f940-pdf.test.ts",
    "test/f941-pdf.test.ts",
    "test/futa-cap.test.ts",
    "test/futa-credit.test.ts",
    "test/in-year-940.test.ts",
    "test/calendar.test.ts",
    "test/mailing-address.test.ts",
  ],
  coverageAnalysis: "perTest",
  // Static mutants (module-level constants) force a full reload per mutant.
  ignoreStatic: true,
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // ubuntu-latest runners have 4 vCPUs.
  concurrency: 4,
  timeoutMS: 30_000,
  dryRunTimeoutMinutes: 15,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  // Baseline 2026-09 (plan/mutation-baseline-2026-09.md): break sits a little
  // below the measured score so a drop fails the run.
  thresholds: { high: 80, low: 60, break: 70 },
};
