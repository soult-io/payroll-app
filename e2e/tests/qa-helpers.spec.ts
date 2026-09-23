/**
 * Spec 18 (PAY-55) — guard for the live-QA login backoff.
 *
 * ONE test on purpose. It lives in Playwright's testDir, so it is ingested by
 * the verify summary and rendered as a journey card; four separate assertions
 * would put four pseudo-journeys ("extendedTimeoutMs is monotonic…") on the
 * very dashboard this spec is cleaning up. `expect.soft` keeps all four
 * failures visible in one card.
 *
 * It requests no page/browser fixture, so it costs a worker slot and nothing
 * else. It exists because the invariant it guards is invisible at runtime: a
 * backoff longer than the test budget does not error, it just guarantees a
 * timeout, which then gets relabelled "flaky" and — before spec 18 — "PASS".
 */

import { expect, test } from "@playwright/test";
import { LOGIN_BACKOFF_SLACK_MS, LOGIN_RATE_LIMIT_BACKOFF_MS, extendedTimeoutMs } from "./qa.js";

test("guard: the login rate-limit backoff fits inside the extended test budget", () => {
  // Not a wish — a statement of the situation the helper must handle. The
  // suite's timeout is 60s (e2e/playwright.config.ts) and the credential
  // rate-limit window is longer, so loginAs MUST extend its own budget.
  expect.soft(LOGIN_RATE_LIMIT_BACKOFF_MS).toBeGreaterThan(60_000);

  const extended = extendedTimeoutMs(60_000, LOGIN_RATE_LIMIT_BACKOFF_MS);
  expect.soft(extended).toBeGreaterThan(60_000 + LOGIN_RATE_LIMIT_BACKOFF_MS);
  expect.soft(extended).toBe(60_000 + LOGIN_RATE_LIMIT_BACKOFF_MS + LOGIN_BACKOFF_SLACK_MS);

  // test.setTimeout(0) means "no timeout". Adding to it would silently impose
  // one, so 0 must stay 0.
  expect.soft(extendedTimeoutMs(0, LOGIN_RATE_LIMIT_BACKOFF_MS)).toBe(0);

  expect.soft(extendedTimeoutMs(60_000, 10_000)).toBeLessThan(extendedTimeoutMs(60_000, 20_000));
});
