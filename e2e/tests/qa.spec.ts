/**
 * Spec 14 §3 e2e specs — written to run against LIVE QA (E2E_BASE_URL set,
 * seeded by `pnpm seed:qa`) and, where feasible, against the ephemeral
 * PGlite boot as well.
 *
 * Live-QA constraints (shared environment!):
 * - READ-ONLY assertions only: no approving/voiding runs, no change requests,
 *   no profile edits. The one permitted mutation is the admin "send test
 *   email" observability action, which is idempotent-by-design (it just
 *   queues another outbox row captured by Mailpit).
 * - Fixture data comes from the documented seed:qa personas, never from the
 *   ephemeral .state file.
 */

import { expect, test } from "@playwright/test";

/** Non-null or throw — keeps specs free of `!` assertions. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

import {
  EMPLOYEE_SESSION_PATH,
  LIVE_QA,
  loadEphemeralState,
  loginAs,
  QA_ADMIN,
  QA_EMPLOYEE,
  QA_EXPORT_TOKEN,
} from "./qa.js";

test("login: password + TOTP (fixed seeded credentials in live QA)", async ({ page }) => {
  const user = LIVE_QA ? QA_ADMIN : loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first (e2e:serve boot writes it)");
  await loginAs(page, must(user, "fixture user"));
});

test("payslip PDF download round-trip (%PDF magic, non-trivial bytes)", async ({
  page,
  browser,
}) => {
  if (LIVE_QA) {
    // Carol Mockington (qa-employee login) has 19 issued payslips from the seed.
    await loginAs(page, QA_EMPLOYEE);
    await page.goto("/my/payslips");
    // The employee payslips table shows Period/Pay date/Gross/Net — no status
    // column (every listed row is issued by definition). Take the first data
    // row; row-click navigates to the detail view.
    const row = page.locator("tbody tr").first();
    await expect(row).toBeVisible();
    await row.click();
    await page.waitForURL(/\/my\/payslips\/[0-9a-f-]{36}/);
    const publicId = must(page.url().split("/").pop(), "payslip publicId in URL");
    const pdf = await page.request.get(`/api/payslips/${publicId}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(2000);
    return;
  }

  // Ephemeral: journey 1 saves the employee session; journey 2 issues the run.
  const state = loadEphemeralState();
  test.skip(!state, "ephemeral state missing — journeys write it");
  const ctx = await browser.newContext({ storageState: EMPLOYEE_SESSION_PATH });
  try {
    const emp = await ctx.newPage();
    const pdf = await emp.request.get(
      `/api/payslips/${must(state, "ephemeral state").run.publicId}/pdf`,
    );
    expect(pdf.status()).toBe(200);
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(2000);
  } finally {
    await ctx.close();
  }
});

test("scheduler draft: seeded current-period run shows in admin approvals (read-only)", async ({
  page,
}) => {
  test.skip(!LIVE_QA, "live-QA only — the ephemeral boot has no pg-boss scheduler context");
  await loginAs(page, QA_ADMIN);
  await page.goto("/admin/payroll");
  // The list defaults to the current year; the seed leaves ONE current-period
  // draft awaiting approval. Read-only assertion — never approve/void here.
  const row = page.locator("tr", { hasText: "Awaiting approval" }).first();
  await expect(row).toBeVisible();
});

test("email capture: admin test email lands in Mailpit (via /api/qa/mailbox)", async ({ page }) => {
  test.skip(!LIVE_QA, "live-QA only — Mailpit capture requires APP_ENV=qa");
  test.setTimeout(240_000);

  await loginAs(page, QA_ADMIN);
  // Benign, idempotent-by-design observability action (queues an outbox row).
  // POST must come from inside the page: the server's csrfOriginCheck rejects
  // mutating requests without a matching Origin (page.request sends none).
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/admin/settings/test-email", { method: "POST" });
    return res.status;
  });
  expect(status).toBe(202);

  // The outbox drain worker runs every minute in QA — poll the mailbox.
  const deadline = Date.now() + 200_000;
  let found: { subject: string; text: string } | null = null;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/qa/mailbox?to=${encodeURIComponent(QA_ADMIN.email)}&latest=true`,
      { headers: { authorization: `Bearer ${QA_EXPORT_TOKEN}` } },
    );
    if (res.ok()) {
      const body = (await res.json()) as { subject: string; text: string };
      if (body.subject.includes("test email")) {
        found = body;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  expect(found, "test email to appear in Mailpit within ~3 minutes").toBeTruthy();
  expect(must(found, "test email in Mailpit").text).toContain("SMTP delivery is working");
});
