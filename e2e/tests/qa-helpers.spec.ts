/**
 * Spec 18 (PAY-55) — pure-helper checks for the live-QA fixtures.
 *
 * These request no page/browser fixture, so they cost a worker slot and
 * nothing else. They exist because the invariant they guard is invisible at
 * runtime: a backoff longer than the test budget does not error, it just
 * guarantees a timeout, which then gets relabelled "flaky" and, before spec 18,
 * "PASS" on the dashboard.
 */

import { expect, test } from "@playwright/test";
import { LOGIN_BACKOFF_SLACK_MS, LOGIN_RATE_LIMIT_BACKOFF_MS, extendedTimeoutMs } from "./qa.js";

test("the rate-limit backoff does not fit inside the default test budget", () => {
  // Not a wish — a statement of the situation the helper must handle. The
  // suite's timeout is 60s (e2e/playwright.config.ts) and the credential
  // rate-limit window is longer than that, so loginAs MUST extend its own
  // budget rather than sleep and hope.
  expect(LOGIN_RATE_LIMIT_BACKOFF_MS).toBeGreaterThan(60_000);
});

test("extendedTimeoutMs leaves room for the backoff plus slack", () => {
  const extended = extendedTimeoutMs(60_000, LOGIN_RATE_LIMIT_BACKOFF_MS);
  expect(extended).toBeGreaterThan(60_000 + LOGIN_RATE_LIMIT_BACKOFF_MS);
  expect(extended).toBe(60_000 + LOGIN_RATE_LIMIT_BACKOFF_MS + LOGIN_BACKOFF_SLACK_MS);
});

test("extendedTimeoutMs never turns Playwright's no-timeout (0) into a finite one", () => {
  // test.setTimeout(0) means "no timeout". Adding to it would silently impose
  // one, so 0 must stay 0.
  expect(extendedTimeoutMs(0, LOGIN_RATE_LIMIT_BACKOFF_MS)).toBe(0);
});

test("extendedTimeoutMs is monotonic in the backoff", () => {
  expect(extendedTimeoutMs(60_000, 10_000)).toBeLessThan(extendedTimeoutMs(60_000, 20_000));
});
