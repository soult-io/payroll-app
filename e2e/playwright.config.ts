/**
 * Playwright config (hardening B + spec 14 §3):
 *
 * - DEFAULT (ephemeral): the webServer is the real Fastify app booted against
 *   in-memory PGlite by @payroll/server's e2e:serve script (migrations +
 *   seeds + fixtures; serves the built SPA from apps/web/dist).
 * - LIVE QA (E2E_BASE_URL set): no local server is booted — the suite runs
 *   against that URL (the nightly job targets https://payroll-qa.stabpablo.eu).
 *   Fixture-driven specs branch: journeys are ephemeral-only; the qa.spec
 *   specs use the documented seeded QA credentials/TOTP and stay read-only.
 *
 * Chromium only; serial (journeys share the single in-memory database).
 */

import { defineConfig, devices } from "@playwright/test";

const liveBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
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
        },
      }),
});
