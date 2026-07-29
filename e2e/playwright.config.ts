/**
 * Playwright config (hardening B): the webServer is the real Fastify app
 * booted against in-memory PGlite by @payroll/server's e2e:serve script
 * (migrations + seeds + fixtures; serves the built SPA from apps/web/dist).
 * Chromium only; serial (journeys share the single in-memory database).
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:9898",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @payroll/server e2e:serve",
    url: "http://127.0.0.1:9898/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
