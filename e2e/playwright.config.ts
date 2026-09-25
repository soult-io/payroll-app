/**
 * Playwright config (hardening B + spec 14 §3):
 *
 * - DEFAULT (ephemeral): the webServer is the real Fastify app booted against
 *   in-memory PGlite by @payroll/server's e2e:serve script (migrations +
 *   seeds + fixtures; serves the built SPA from apps/web/dist).
 * - LIVE QA (E2E_BASE_URL set): no local server is booted — the suite runs
 *   against that URL (the nightly job sets it from the QA_E2E_BASE_URL repo
 *   variable; unset → ephemeral default).
 *   Fixture-driven specs branch: journeys are ephemeral-only; the qa.spec
 *   specs use the documented seeded QA credentials/TOTP and stay read-only.
 *
 * Chromium only; serial (journeys share the single in-memory database).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const liveBaseUrl = process.env.E2E_BASE_URL;
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // CI also writes a json report (spec 17 §2) — the verify-summary job and the
  // pay-verify site consume it. Output path is relative to this config's dir.
  //
  // The journey-evidence reporter (spec 20) runs only for the ephemeral CI
  // boot, never against live QA (spec 20 D2). It writes next to the stills
  // under test-results/, which the e2e job uploads as pay-verify-evidence.
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-results.json" }],
        ...(liveBaseUrl
          ? []
          : [
              [
                "./reporters/evidence-reporter.ts",
                { outputFile: resolve(HERE, "test-results/journey-evidence.json") },
              ] as const,
            ]),
      ]
    : [["list"]],
  use: {
    baseURL: liveBaseUrl ?? "http://127.0.0.1:9898",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(liveBaseUrl
    ? {}
    : {
        webServer: {
          command: "pnpm --filter @payroll/server e2e:serve",
          url: "http://127.0.0.1:9898/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          // Playwright ignores webServer stdout by default. The boot logs the
          // DATE it seeded for, and the dataset is clock-dependent, so with
          // `reuseExistingServer` on a stale boot from last month silently
          // invalidates the "previous calendar month" assertions. Piping it is
          // what makes that visible (PAY-56).
          stdout: "pipe",
        },
      }),
});
