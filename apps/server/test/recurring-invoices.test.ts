/**
 * Spec 12 integration tests — recurring contractor invoices. Real SQL via the
 * PGlite harness; the tick/sweep are called directly (pg-boss needs a real
 * Postgres), the CRUD + invoice workflow go through app.inject with a real
 * admin session.
 *
 * Covers: template CRUD + validation, the D25 lifecycle (delete blocked after
 * first generation, pause stops generation, ends_on retires), generation
 * idempotency (double tick → one invoice; the unique-index belt under a stale
 * last_generated_period), last_day vs fixed-day invoice dating, {month}/{year}
 * interpolation, the admin generation notification, the payment-due sweep
 * (fires approved-but-unpaid, idempotent via markers, never fires when paid
 * or unapproved), and the D17 payment gate on generated invoices.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  contractorInvoices,
  contractorRecurringInvoices,
  emailOutbox,
  seedDatabase,
} from "@payroll/db";
import { EVENT_TYPE } from "@payroll/notifications";
import {
  generateRecurringInvoices,
  invoiceDateFor,
  nextGenerationOn,
  paymentDueSweep,
} from "../src/contractors/recurring.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db);
  const admin = await inviteAndOnboard(t, { email: "admin@test.dev", role: "admin" });
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
): ReturnType<typeof t.app.inject> {
  return t.app.inject({
    method,
    url,
    headers: ADMIN,
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function makeContractor(overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await api("POST", "/api/admin/contractors", {
    legalName: "Recurring Riley",
    hireDate: "2026-01-05",
    taxStatus: "us_person",
    entityType: "individual",
    taxForm: "w9",
    formCollectedAt: "2025-12-01",
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { employeeId: number }).employeeId;
}

interface TemplateOverrides {
  description?: string;
  amount?: number;
  invoiceDay?: string;
  invoiceDayOfMonth?: number | null;
  payDayOfMonth?: number;
  startsOn?: string;
  endsOn?: string | null;
}

async function makeTemplate(
  employeeId: number,
  overrides: TemplateOverrides = {},
): Promise<number> {
  const res = await api("POST", `/api/admin/contractors/${employeeId}/recurring`, {
    description: "Monthly retainer — {month} {year}",
    amount: 2000,
    invoiceDay: "last_day",
    payDayOfMonth: 11,
    startsOn: "2026-01-01",
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { template: { id: number } }).template.id;
}

async function invoicesFor(employeeId: number) {
  return t.db
    .select()
    .from(contractorInvoices)
    .where(eq(contractorInvoices.employeeId, employeeId))
    .orderBy(contractorInvoices.id);
}

async function templateRow(templateId: number) {
  const rows = await t.db
    .select()
    .from(contractorRecurringInvoices)
    .where(eq(contractorRecurringInvoices.id, templateId));
  return rows[0]!;
}

async function outboxEvents(eventType: string) {
  return t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, eventType));
}

const tick = (today: string) =>
  generateRecurringInvoices({ db: t.db, config: t.config }, { today });
const sweep = (today: string) => paymentDueSweep({ db: t.db, config: t.config }, { today });

// ---------------------------------------------------------------------------
// Template CRUD + validation
// ---------------------------------------------------------------------------

describe("template CRUD (spec 12 §1)", () => {
  it("creates and lists templates with a computed next generation date", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId);

    const res = await api("GET", `/api/admin/contractors/${employeeId}/recurring`);
    expect(res.statusCode, res.body).toBe(200);
    const { templates } = res.json() as {
      templates: {
        id: number;
        amount: string;
        invoiceDay: string;
        payDayOfMonth: number;
        active: boolean;
        nextGenerationOn: string | null;
      }[];
    };
    const row = templates.find((r) => r.id === templateId);
    expect(row).toBeDefined();
    expect(row!.amount).toBe("2000.00");
    expect(row!.invoiceDay).toBe("last_day");
    expect(row!.payDayOfMonth).toBe(11);
    expect(row!.active).toBe(true);
    expect(row!.nextGenerationOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects invalid schedules and non-contractors", async () => {
    const employeeId = await makeContractor();
    // fixed without a day → 400
    const missing = await api("POST", `/api/admin/contractors/${employeeId}/recurring`, {
      description: "x",
      amount: 100,
      invoiceDay: "fixed",
      payDayOfMonth: 11,
      startsOn: "2026-01-01",
    });
    expect(missing.statusCode, missing.body).toBe(400);
    // pay day > 28 → 400 (zod range, mirrors the DB CHECK)
    const badPayDay = await api("POST", `/api/admin/contractors/${employeeId}/recurring`, {
      description: "x",
      amount: 100,
      payDayOfMonth: 29,
      startsOn: "2026-01-01",
    });
    expect(badPayDay.statusCode, badPayDay.body).toBe(400);
    // ends before start → 400
    const badRange = await api("POST", `/api/admin/contractors/${employeeId}/recurring`, {
      description: "x",
      amount: 100,
      payDayOfMonth: 11,
      startsOn: "2026-06-01",
      endsOn: "2026-05-01",
    });
    expect(badRange.statusCode, badRange.body).toBe(400);
    // W-2 / unknown employee → 404
    const notContractor = await api("POST", "/api/admin/contractors/999999/recurring", {
      description: "x",
      amount: 100,
      payDayOfMonth: 11,
      startsOn: "2026-01-01",
    });
    expect(notContractor.statusCode, notContractor.body).toBe(404);
  });

  it("edits change future generations only; last_day clears the fixed day", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId, {
      invoiceDay: "fixed",
      invoiceDayOfMonth: 15,
    });
    const res = await api("PATCH", `/api/admin/recurring/${templateId}`, {
      amount: 2500,
      invoiceDay: "last_day",
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await templateRow(templateId);
    expect(row.amount).toBe("2500.00");
    expect(row.invoiceDay).toBe("last_day");
    expect(row.invoiceDayOfMonth).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D25 lifecycle: delete / pause / end
// ---------------------------------------------------------------------------

describe("D25 lifecycle", () => {
  it("delete works before the first generation and is blocked after", async () => {
    const employeeId = await makeContractor();
    const deletable = await makeTemplate(employeeId);
    const del = await api("DELETE", `/api/admin/recurring/${deletable}`);
    expect(del.statusCode, del.body).toBe(200);
    expect(await templateRow(deletable)).toBeUndefined();

    const used = await makeTemplate(employeeId);
    await tick("2026-07-31");
    const blocked = await api("DELETE", `/api/admin/recurring/${used}`);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect((blocked.json() as { error: string }).error).toBe("invalid_transition");
    expect(await templateRow(used)).toBeDefined();
  });

  it("pause stops generation; resume restarts it", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId);
    await api("PATCH", `/api/admin/recurring/${templateId}`, { active: false });

    // The tick is global; assertions are scoped to this contractor.
    await tick("2026-07-31");
    expect(await invoicesFor(employeeId)).toHaveLength(0);

    await api("PATCH", `/api/admin/recurring/${templateId}`, { active: true });
    await tick("2026-08-31");
    expect(await invoicesFor(employeeId)).toHaveLength(1);
  });

  it("ends_on generates the last period, then the template retires itself", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId, { endsOn: "2026-07-31" });
    await tick("2026-07-31");
    const row = await templateRow(templateId);
    expect(row.active).toBe(false);
    expect(row.lastGeneratedPeriod).toBe("2026-07");
    await tick("2026-08-31");
    expect(await invoicesFor(employeeId)).toHaveLength(1);
  });

  it("ends_on before the period invoice date retires without generating", async () => {
    const employeeId = await makeContractor();
    // last_day template, contract ends mid-July → July's 31st invoice is past
    // the end, so the tick retires the template instead of generating.
    const templateId = await makeTemplate(employeeId, { endsOn: "2026-07-15" });
    await tick("2026-07-31");
    expect((await templateRow(templateId)).active).toBe(false);
    expect(await invoicesFor(employeeId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Generation tick (spec 12 §2)
// ---------------------------------------------------------------------------

describe("generation tick (spec 12 §2)", () => {
  it("last_day template generates on the last day, interpolated, as submitted", async () => {
    const employeeId = await makeContractor({ legalName: "Lucy Lastday" });
    const templateId = await makeTemplate(employeeId, { amount: 2000 });

    await tick("2026-07-30");
    expect(await invoicesFor(employeeId)).toHaveLength(0);
    await tick("2026-07-31");

    const invoices = await invoicesFor(employeeId);
    expect(invoices).toHaveLength(1);
    const inv = invoices[0]!;
    expect(inv.invoiceDate).toBe("2026-07-31");
    expect(inv.description).toBe("Monthly retainer — July 2026");
    expect(inv.amount).toBe("2000.00");
    expect(inv.status).toBe("submitted");
    expect(inv.submittedBy).toBeNull();
    expect(inv.recurringTemplateId).toBe(templateId);
    expect(inv.recurringPeriod).toBe("2026-07");

    // Admin notification through the outbox (spec §2).
    const mails = await outboxEvents(EVENT_TYPE.contractorRecurringGenerated);
    const mail = mails.find((m) => m.bodyHtml.includes("Lucy Lastday"));
    expect(mail).toBeDefined();
    expect(mail!.bodyHtml).toContain("July 2026");
  });

  it("fixed-day template generates on the configured day only", async () => {
    const employeeId = await makeContractor();
    await makeTemplate(employeeId, { invoiceDay: "fixed", invoiceDayOfMonth: 15 });

    await tick("2026-07-14");
    expect(await invoicesFor(employeeId)).toHaveLength(0);
    await tick("2026-07-15");

    const invoices = await invoicesFor(employeeId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.invoiceDate).toBe("2026-07-15");
    expect(invoices[0]!.recurringPeriod).toBe("2026-07");
  });

  it("is idempotent: a double tick generates exactly one invoice", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId);

    await tick("2026-07-31");
    await tick("2026-07-31");
    expect(await invoicesFor(employeeId)).toHaveLength(1);

    // The unique index is the belt even when last_generated_period is stale.
    await t.db
      .update(contractorRecurringInvoices)
      .set({ lastGeneratedPeriod: null })
      .where(eq(contractorRecurringInvoices.id, templateId));
    await tick("2026-07-31");
    expect(await invoicesFor(employeeId)).toHaveLength(1);
  });

  it("does not generate before starts_on", async () => {
    const employeeId = await makeContractor();
    await makeTemplate(employeeId, { startsOn: "2026-08-01" });
    await tick("2026-07-31");
    expect(await invoicesFor(employeeId)).toHaveLength(0);
    await tick("2026-08-31");
    expect(await invoicesFor(employeeId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Payment-due sweep (spec 12 §3)
// ---------------------------------------------------------------------------

describe("payment-due sweep (spec 12 §3)", () => {
  async function generatedAndApproved(payDayOfMonth = 11) {
    const employeeId = await makeContractor({ legalName: "Due Daisy" });
    await makeTemplate(employeeId, { payDayOfMonth });
    await tick("2026-07-31");
    const inv = (await invoicesFor(employeeId))[0]!;
    const res = await api("POST", `/api/admin/invoices/${inv.id}/approve`, {});
    expect(res.statusCode, res.body).toBe(200);
    return { employeeId, invoiceId: inv.id };
  }

  it("notifies admins on pay day when approved-but-unpaid, once per day", async () => {
    const { invoiceId } = await generatedAndApproved();
    // Wrong day → nothing.
    expect(await sweep("2026-08-10")).toEqual({ due: 0 });
    // Pay day of the following month → one notification.
    expect(await sweep("2026-08-11")).toEqual({ due: 1 });
    const mails = await outboxEvents(EVENT_TYPE.contractorRecurringPaymentDue);
    expect(mails.length).toBeGreaterThan(0);
    expect(mails[0]!.bodyHtml).toContain(`payment-due:${invoiceId}:2026-08-11`);
    expect(mails[0]!.bodyHtml).toContain("Due Daisy");
    // Idempotent via the outbox marker — same day, no repeat.
    expect(await sweep("2026-08-11")).toEqual({ due: 0 });
  });

  it("never fires when the payment is already recorded", async () => {
    const { invoiceId } = await generatedAndApproved();
    const pay = await api("POST", `/api/admin/invoices/${invoiceId}/pay`, {
      payDate: "2026-08-05",
      amount: 2000,
      method: "ach",
    });
    expect(pay.statusCode, pay.body).toBe(201);
    expect(await sweep("2026-08-11")).toEqual({ due: 0 });
    const mails = await outboxEvents(EVENT_TYPE.contractorRecurringPaymentDue);
    expect(mails.some((m) => m.bodyHtml.includes(`payment-due:${invoiceId}:`))).toBe(false);
  });

  it("never fires for unapproved (submitted) invoices", async () => {
    const employeeId = await makeContractor();
    await makeTemplate(employeeId);
    await tick("2026-07-31");
    expect(await sweep("2026-08-11")).toEqual({ due: 0 });
  });
});

// ---------------------------------------------------------------------------
// Generated invoices obey the existing workflow (D22/D17)
// ---------------------------------------------------------------------------

describe("generated invoices obey the existing D17 payment gate", () => {
  it("blocks payment when the contractor's form is outstanding", async () => {
    // No formCollectedAt → the payment gate must name the missing form.
    const employeeId = await makeContractor({
      legalName: "Gate Gary",
      formCollectedAt: undefined,
    });
    await makeTemplate(employeeId);
    await tick("2026-07-31");
    const inv = (await invoicesFor(employeeId))[0]!;
    const approve = await api("POST", `/api/admin/invoices/${inv.id}/approve`, {});
    expect(approve.statusCode, approve.body).toBe(200);
    const pay = await api("POST", `/api/admin/invoices/${inv.id}/pay`, {
      payDate: "2026-08-11",
      amount: 2000,
      method: "ach",
    });
    expect(pay.statusCode, pay.body).toBe(409);
    expect((pay.json() as { error: string }).error).toBe("form_missing");
  });

  it("generated invoices appear in the ordinary detail queue with the recurring marker", async () => {
    const employeeId = await makeContractor();
    const templateId = await makeTemplate(employeeId);
    await tick("2026-07-31");
    const res = await api("GET", `/api/admin/contractors/${employeeId}`);
    expect(res.statusCode, res.body).toBe(200);
    const { invoices } = res.json() as {
      invoices: { recurringTemplateId: number | null; status: string }[];
    };
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.recurringTemplateId).toBe(templateId);
    expect(invoices[0]!.status).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// Pure date logic
// ---------------------------------------------------------------------------

describe("schedule date logic (D24)", () => {
  it("computes invoice dates for last_day vs fixed, across short months", () => {
    expect(invoiceDateFor({ invoiceDay: "last_day", invoiceDayOfMonth: null }, 2026, 2)).toBe(
      "2026-02-28",
    );
    expect(invoiceDateFor({ invoiceDay: "last_day", invoiceDayOfMonth: null }, 2024, 2)).toBe(
      "2024-02-29",
    );
    expect(invoiceDateFor({ invoiceDay: "fixed", invoiceDayOfMonth: 28 }, 2026, 2)).toBe(
      "2026-02-28",
    );
    expect(invoiceDateFor({ invoiceDay: "fixed", invoiceDayOfMonth: 5 }, 2026, 12)).toBe(
      "2026-12-05",
    );
  });

  it("nextGenerationOn rolls to the following month after generation", () => {
    const base = {
      id: 1,
      employeeId: 1,
      description: "x",
      amount: "100.00",
      currency: "USD",
      invoiceDay: "last_day",
      invoiceDayOfMonth: null,
      payDayOfMonth: 11,
      active: true,
      startsOn: "2026-01-01",
      endsOn: null,
      createdAt: null,
      updatedAt: null,
    };
    expect(nextGenerationOn({ ...base, lastGeneratedPeriod: null }, "2026-07-15")).toBe(
      "2026-07-31",
    );
    expect(nextGenerationOn({ ...base, lastGeneratedPeriod: "2026-07" }, "2026-07-31")).toBe(
      "2026-08-31",
    );
    expect(
      nextGenerationOn({ ...base, active: false, lastGeneratedPeriod: null }, "2026-07-15"),
    ).toBeNull();
    expect(
      nextGenerationOn({ ...base, endsOn: "2026-07-15", lastGeneratedPeriod: null }, "2026-07-15"),
    ).toBeNull();
  });
});
