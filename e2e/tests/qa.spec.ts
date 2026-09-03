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
  newAuthedPage,
  QA_ADMIN,
  QA_CONTRACTOR,
  QA_EMPLOYEE,
  QA_EXPORT_TOKEN,
} from "./qa.js";

test("login: password + TOTP (fixed seeded credentials in live QA)", async ({ page }) => {
  const user = LIVE_QA ? QA_ADMIN : loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first (e2e:serve boot writes it)");
  await loginAs(page, must(user, "fixture user"));
});

test("payslip PDF download round-trip (%PDF magic, non-trivial bytes)", async ({ browser }) => {
  if (LIVE_QA) {
    // Carol Mockington (qa-employee login) has 19 issued payslips from the seed.
    const page = await newAuthedPage(browser, QA_EMPLOYEE);
    try {
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
    } finally {
      await page.context().close();
    }
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
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — the ephemeral boot has no pg-boss scheduler context");
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    await page.goto("/admin/payroll");
    // The list defaults to the current year; the seed leaves ONE current-period
    // draft awaiting approval. Read-only assertion — never approve/void here.
    const row = page.locator("tr", { hasText: "Awaiting approval" }).first();
    await expect(row).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("contractor My Invoices: Dave sees approved+paid invoices, PDF round-trips (PAY-7)", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — needs the seeded contractor login (seed-qa Dave)");
  const page = await newAuthedPage(browser, QA_CONTRACTOR);
  try {
    // UI surface: the list page shows Dave's seeded invoices with status chips.
    await page.goto("/my/invoices");
    const row = page.locator("tbody tr").first();
    await expect(row).toBeVisible();
    await expect(page.getByText("Paid").first()).toBeVisible();

    // API surface (read-only): D1 visibility — only approved/paid leave the
    // server; paid rows carry the payment join.
    const list = await page.request.get("/api/my/invoices");
    expect(list.status()).toBe(200);
    const { invoices } = (await list.json()) as {
      invoices: { id: number; status: string; payment: unknown }[];
    };
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.every((i) => ["approved", "paid"].includes(i.status))).toBe(true);
    expect(invoices.some((i) => i.status === "paid" && i.payment !== null)).toBe(true);

    // PDF round-trip on the first listed invoice.
    const pdf = await page.request.get(`/api/my/invoices/${invoices[0]!.id}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  } finally {
    await page.context().close();
  }
});

test("PAY-8 scoped UI: contractor sees Invoices, not Payslips; /my/payslips redirects", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — needs the seeded contractor login (seed-qa Dave)");
  const page = await newAuthedPage(browser, QA_CONTRACTOR);
  try {
    await page.goto("/my/dashboard");
    const nav = page.locator("nav .nav-link");
    await expect(nav.getByText("Invoices")).toBeVisible();
    await expect(nav.getByText("Payslips")).toHaveCount(0);

    // Direct URL to the wrong-type feature redirects to the dashboard.
    await page.goto("/my/payslips");
    await expect(page).toHaveURL(/\/my\/dashboard$/);

    // Admin-only notification events are not offered to a contractor.
    const settings = await page.request.get("/api/my/notification-settings");
    expect(settings.status()).toBe(200);
    const { settings: rows } = (await settings.json()) as {
      settings: { eventType: string }[];
    };
    const eventTypes = rows.map((r) => r.eventType);
    expect(eventTypes).not.toContain("payroll_draft_ready");
    expect(eventTypes).not.toContain("change_request_submitted");
    expect(eventTypes).not.toContain("payslip_issued");
    expect(eventTypes).toContain("contractor_invoice_paid");
  } finally {
    await page.context().close();
  }
});

test("tax deposits: admin sees the computed schedule incl. last month (PAY-9)", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — deposit rows come from the seeded QA payroll history");
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    await page.goto("/admin/deposits");
    await expect(page.getByRole("heading", { name: "Tax deposits" })).toBeVisible();

    // The QA seed syncs deposits from 2 years of issued payroll history — the
    // previous calendar month must be listed (read-only assertion).
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const label = `${prev.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${prev.getUTCFullYear()}`;
    await expect(page.locator("tbody tr", { hasText: label }).first()).toBeVisible();

    // Jurisdiction + reminder schedule editor render.
    await expect(page.locator("tbody").getByText("federal").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reminder schedule" })).toBeVisible();

    // API surface (read-only): newest period first, federal jurisdiction.
    const list = await page.request.get("/api/admin/tax-deposits");
    expect(list.status()).toBe(200);
    const { deposits } = (await list.json()) as {
      deposits: { periodStart: string; jurisdiction: string; amount: string }[];
    };
    expect(deposits.length).toBeGreaterThan(0);
    expect(deposits.every((d) => d.jurisdiction === "federal")).toBe(true);
    expect(Number(deposits[0]!.amount)).toBeGreaterThan(0);
  } finally {
    await page.context().close();
  }
});

test("W-2/W-3 filing detail: full headers, Documents column, W-3 action placement (PAY-23)", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — the 2025 W-2/W-3 row comes from the seeded QA history");
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    await page.goto("/admin/filings");
    const row = page
      .locator("tbody tr", { hasText: "W-2/W-3" })
      .filter({ hasText: "2025" })
      .first();
    await expect(row).toBeVisible();
    await row.click();

    await expect(page.getByRole("heading", { name: /Forms W-2\/W-3 — 2025/ })).toBeVisible();

    const w3Section = page.locator("section", {
      has: page.getByRole("heading", { name: /W-3 transmittal totals/ }),
    });
    // The W-3 download belongs to the transmittal header, not the W-2 list.
    await expect(w3Section.getByRole("button", { name: "Download W-3 PDF" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Employee W-2s" })).toBeVisible();

    // Full column titles; Delivery (status) and Documents (actions) are split.
    const w2Table = w3Section.locator("table").last();
    for (const label of [
      "Wages, tips, other compensation",
      "Federal income tax withheld",
      "Social Security tax",
      "Medicare tax",
      "Delivery",
      "Documents",
    ]) {
      await expect(w2Table.locator("th", { hasText: label }).first()).toBeVisible();
    }
    await expect(w2Table.getByRole("button", { name: "Download Copy D" }).first()).toBeVisible();
    await expect(w2Table.getByRole("button", { name: "Print packet" }).first()).toBeVisible();

    // The abbreviated double-wrapping headers are gone.
    await expect(w2Table.getByText("fed. withheld")).toHaveCount(0);
    await expect(w2Table.getByText("SS tax")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("email capture: admin test email lands in Mailpit (via /api/qa/mailbox)", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — Mailpit capture requires APP_ENV=qa");
  test.setTimeout(240_000);

  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    // Benign, idempotent-by-design observability action (queues an outbox row).
    // POST must come from inside the page: the server's csrfOriginCheck rejects
    // mutating requests without a matching Origin (page.request sends none).
    // Navigate first — a fresh context page sits on about:blank, where the
    // relative fetch URL cannot resolve.
    await page.goto("/");
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
  } finally {
    await page.context().close();
  }
});
