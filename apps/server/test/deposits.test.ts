/**
 * PAY-9 integration tests — monthly federal tax deposits. Real SQL via the
 * PGlite harness; syncDeposits / sendDepositReminders are called directly
 * (pg-boss needs a real Postgres), the admin routes go through app.inject
 * with a real admin session.
 *
 * Covers: due-date calc incl. weekend roll and year rollover, amount
 * derivation from issued runs to the cent (draft/void runs excluded,
 * employer_futa excluded), syncDeposits idempotency + pending-row
 * recomputation when a late run issues + the overdue flip, the mark-deposited
 * flow (200 + audit event + status change; invalid confirmation and double
 * deposit rejected; RBAC), the reminder schedule setting (default [5,0],
 * custom offsets, validation), and the reminder sweep (fires on the right
 * dates, never twice for the same offset, custom offsets honored).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxDeposits,
  type SeedDb,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE } from "@payroll/notifications";
import {
  computeDepositAmount,
  DEFAULT_REMINDER_OFFSETS,
  DEPOSIT_CATEGORIES,
  dueDateFor,
  sendDepositReminders,
  syncDeposits,
} from "../src/deposits/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;
let adminUserId: string;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "deposits-admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let employeeSeq = 0;
async function createEmployee(): Promise<number> {
  employeeSeq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]!.id,
      legalName: `Deposit Test Employee ${employeeSeq}`,
      hireDate: "2025-01-01",
    })
    .returning();
  return rows[0]!.id;
}

async function addCompensation(employeeId: number, periodAmount: number): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(periodAmount),
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });
}

/** Generate → approve → issue a monthly run; returns the run row. */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0]!;
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  const rows = await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
  expect(rows[0]!.status).toBe("issued");
  return rows[0]!;
}

async function api(
  method: "GET" | "POST" | "PUT",
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

async function depositRow(periodStart: string) {
  const rows = await t.db
    .select()
    .from(taxDeposits)
    .where(and(eq(taxDeposits.jurisdiction, "federal"), eq(taxDeposits.periodStart, periodStart)));
  return rows[0];
}

async function depositReminderOutbox() {
  return t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, EVENT_TYPE.taxDepositDue));
}

/** Expected deposit amount: the five categories summed from the DB itself. */
async function expectedAmount(year: number, month: number): Promise<string> {
  const mm = String(month).padStart(2, "0");
  const runs = await t.db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.status, "issued")));
  const inMonth = runs.filter((r) => r.payDate.startsWith(`${year}-${mm}-`));
  let total = 0;
  for (const run of inMonth) {
    const entries = await t.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.runId, run.id));
    for (const e of entries) {
      if ((DEPOSIT_CATEGORIES as readonly string[]).includes(e.category)) {
        total += Number(e.amount);
      }
    }
  }
  return round2(total).toFixed(2);
}

// ---------------------------------------------------------------------------
// dueDateFor — pure date math
// ---------------------------------------------------------------------------

describe("dueDateFor (PAY-9 domain rules)", () => {
  it("is the 15th of the following month, incl. year rollover", () => {
    expect(dueDateFor(2026, 4)).toBe("2026-05-15"); // Friday — no roll
    expect(dueDateFor(2025, 12)).toBe("2026-01-15"); // December → January
  });

  it("rolls weekend due dates forward to the next business day", () => {
    // 2026-08-15 is a Saturday → Monday the 17th (ticket example).
    expect(dueDateFor(2026, 7)).toBe("2026-08-17");
    // 2026-02-15 is a Sunday → Monday the 16th.
    expect(dueDateFor(2026, 1)).toBe("2026-02-16");
  });
});

// ---------------------------------------------------------------------------
// computeDepositAmount — issued runs only, to the cent
// ---------------------------------------------------------------------------

describe("computeDepositAmount", () => {
  it("sums the five deposit categories across issued runs in the pay month", async () => {
    const a = await createEmployee();
    await addCompensation(a, 4000);
    await issueRun(a, 2026, 3);

    const amount = await computeDepositAmount(t.db, 2026, 3);
    expect(amount).toBe(await expectedAmount(2026, 3));
    expect(Number(amount)).toBeGreaterThan(0);
  });

  it("excludes draft and void runs, and employer_futa", async () => {
    const b = await createEmployee();
    await addCompensation(b, 5000);

    // Draft (awaiting approval) run in April — must not count.
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2026, month: 4, employeeId: b },
    });
    expect(gen.statusCode, gen.body).toBe(201);
    const draft = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0]!;

    const before = await computeDepositAmount(t.db, 2026, 4);
    expect(before).toBe("0.00");

    // Void the draft: still excluded afterwards.
    const voided = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${draft.publicId}/void`,
      headers: ADMIN,
      payload: { reason: "test void" },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await computeDepositAmount(t.db, 2026, 4)).toBe("0.00");

    // Issue it properly (fresh run after void) and it counts.
    await issueRun(b, 2026, 4);
    const amount = await computeDepositAmount(t.db, 2026, 4);
    expect(amount).toBe(await expectedAmount(2026, 4));
    expect(Number(amount)).toBeGreaterThan(0);

    // employer_futa is never part of the deposit (Form 940, out of scope).
    const runs = await t.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.employeeId, b), eq(payrollRuns.status, "issued")));
    const entries = await t.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.runId, runs[0]!.id));
    const futa = entries.find((e) => e.category === "employer_futa");
    expect(futa).toBeDefined();
    const withoutFuta = round2(
      entries
        .filter((e) => (DEPOSIT_CATEGORIES as readonly string[]).includes(e.category))
        .reduce((sum, e) => sum + Number(e.amount), 0),
    ).toFixed(2);
    expect(amount).toBe(withoutFuta);
  });
});

// ---------------------------------------------------------------------------
// syncDeposits — idempotent upsert, recomputation, overdue flip
// ---------------------------------------------------------------------------

describe("syncDeposits", () => {
  it("upserts pending rows for completed months and is idempotent", async () => {
    // 2026-03 has issued runs from the tests above; on 2026-04-10 it is the
    // only completed month and not yet due (due 2026-04-15).
    const first = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-10" });
    expect(first.created).toBe(1);

    const march = await depositRow("2026-03-01");
    expect(march).toBeDefined();
    expect(march!.status).toBe("pending");
    expect(march!.amount).toBe(await expectedAmount(2026, 3));
    expect(march!.dueDate).toBe("2026-04-15");
    expect(march!.jurisdiction).toBe("federal");

    // Second run: no new rows, no rewrites — one row per (jurisdiction, period).
    const second = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-10" });
    expect(second.created).toBe(0);
    expect(second.recomputed).toBe(0);
    const all = await t.db.select().from(taxDeposits);
    expect(all.filter((d) => d.periodStart === "2026-03-01")).toHaveLength(1);
  });

  it("recomputes the amount of a pending row when a late run issues", async () => {
    const c = await createEmployee();
    await addCompensation(c, 6000);
    // A second employee's March run issued AFTER the first sync.
    await issueRun(c, 2026, 3);

    const sync = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-12" });
    expect(sync.recomputed).toBe(1);
    const march = await depositRow("2026-03-01");
    expect(march!.amount).toBe(await expectedAmount(2026, 3));
  });

  it("flips pending rows to overdue once the due date passes", async () => {
    // On 2026-05-01, April is now a completed month too and March is past due.
    const sync = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-05-01" });
    expect(sync.created).toBe(1); // April
    expect(sync.flippedOverdue).toBe(1); // March (due 2026-04-15)
    const march = await depositRow("2026-03-01");
    expect(march!.status).toBe("overdue");
    const april = await depositRow("2026-04-01");
    expect(april!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Admin routes — list + mark deposited + reminder schedule
// ---------------------------------------------------------------------------

describe("admin deposit routes", () => {
  it("lists deposits newest period first", async () => {
    const res = await api("GET", "/api/admin/tax-deposits");
    expect(res.statusCode, res.body).toBe(200);
    const { deposits } = res.json() as { deposits: (typeof taxDeposits.$inferSelect)[] };
    expect(deposits.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < deposits.length; i++) {
      expect(deposits[i - 1]!.periodStart >= deposits[i]!.periodStart).toBe(true);
    }
  });

  it("marks a deposit as deposited — status change + audit event", async () => {
    const april = await depositRow("2026-04-01");
    expect(april).toBeDefined();

    const res = await api("POST", `/api/admin/tax-deposits/${april!.id}/deposit`, {
      depositedOn: "2026-05-14",
      eftpsConfirmation: "EFTPS-123456789",
    });
    expect(res.statusCode, res.body).toBe(200);
    const { deposit } = res.json() as { deposit: typeof taxDeposits.$inferSelect };
    expect(deposit.status).toBe("deposited");
    expect(deposit.depositedOn).toBe("2026-05-14");
    expect(deposit.eftpsConfirmation).toBe("EFTPS-123456789");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "tax_deposit.deposit"),
          eq(auditEvents.entityId, String(april!.id)),
        ),
      )
      .orderBy(desc(auditEvents.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(adminUserId);
    expect((audits[0]!.after as { status: string }).status).toBe("deposited");
  });

  it("rejects an invalid confirmation and a double deposit", async () => {
    const march = await depositRow("2026-03-01");
    const bad = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-14",
      eftpsConfirmation: "   ",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_body" });

    const badDate = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "14/05/2026",
      eftpsConfirmation: "EFTPS-1",
    });
    expect(badDate.statusCode).toBe(400);

    const ok = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-2",
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const again = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-3",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "invalid_transition" });
  });

  it("404s unknown deposits and 403s non-admins", async () => {
    const missing = await api("POST", "/api/admin/tax-deposits/999999/deposit", {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-1",
    });
    expect(missing.statusCode).toBe(404);

    const employee = await inviteAndOnboard(t, { email: "deposits-employee@test.dev" });
    const session = await login(t, employee.email, TEST_PASSWORD);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-deposits",
      headers: sessionHeader(session.sessionCookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("reads the default reminder schedule and saves custom offsets", async () => {
    const initial = await api("GET", "/api/admin/tax-deposits/reminder-schedule");
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ offsets: [...DEFAULT_REMINDER_OFFSETS] });

    const put = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", {
      offsets: [10, 3, 0],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ offsets: [10, 3, 0] });

    const after = await api("GET", "/api/admin/tax-deposits/reminder-schedule");
    expect(after.json()).toMatchObject({ offsets: [10, 3, 0] });

    // Restore the default for the reminder-sweep tests below.
    const restore = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", {
      offsets: [5, 0],
    });
    expect(restore.statusCode, restore.body).toBe(200);
  });

  it("rejects invalid reminder schedules", async () => {
    for (const offsets of [[], [31], [-1], [1.5], Array(11).fill(1)]) {
      const res = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets });
      expect(res.statusCode, `offsets ${JSON.stringify(offsets)}`).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_body" });
    }
  });
});

// ---------------------------------------------------------------------------
// sendDepositReminders — right dates, never twice per offset
// ---------------------------------------------------------------------------

describe("sendDepositReminders", () => {
  it("fires each configured offset once, on due_date minus offset", async () => {
    // Fresh period so reminders_sent starts empty: May 2026, due 2026-06-15.
    const d = await createEmployee();
    await addCompensation(d, 3500);
    await issueRun(d, 2026, 5);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-06-01" });
    const may = await depositRow("2026-05-01");
    expect(may!.status).toBe("pending");
    expect(may!.dueDate).toBe("2026-06-15"); // Monday — no roll

    // Default schedule [5, 0]: offset 5 fires on 2026-06-10.
    const before10 = await depositReminderOutbox();
    const on10 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-10" },
    );
    expect(on10.sent).toBe(1);
    const after10 = await depositReminderOutbox();
    expect(after10.length - before10.length).toBe(1); // one admin recipient

    // Same day again: nothing.
    const again10 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-10" },
    );
    expect(again10.sent).toBe(0);

    // Offset 0 fires on the due date itself, then never again.
    const on15 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-15" },
    );
    expect(on15.sent).toBe(1);
    const again15 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-15" },
    );
    expect(again15.sent).toBe(0);

    const row = await depositRow("2026-05-01");
    expect((row!.remindersSent as number[]).sort()).toEqual([0, 5]);
  });

  it("email body carries jurisdiction, period, amount, due date, and the eftps pointer", async () => {
    const outbox = await depositReminderOutbox();
    const latest = outbox.sort((a, b) => b.id - a.id)[0]!;
    expect(latest.bodyHtml).toContain("Federal");
    expect(latest.bodyHtml).toContain("May 2026");
    expect(latest.bodyHtml).toContain("2026-06-15");
    expect(latest.bodyHtml).toContain("eftps.gov");
    expect(latest.bodyHtml).toContain("<!-- deposit-reminder:");
    const may = await depositRow("2026-05-01");
    const amountLabel = `$${Number(may!.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    expect(latest.bodyHtml).toContain(amountLabel);
  });

  it("honors custom offsets", async () => {
    const e = await createEmployee();
    await addCompensation(e, 4500);
    await issueRun(e, 2026, 6);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-01" });

    await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets: [2] });
    // June deposit is due 2026-07-15; offset 2 fires on 2026-07-13 only.
    const on12 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-07-12" },
    );
    const on13 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-07-13" },
    );
    expect(on12.sent).toBe(0);
    expect(on13.sent).toBeGreaterThanOrEqual(1);
    const june = await depositRow("2026-06-01");
    expect(june!.remindersSent as number[]).toEqual([2]);

    await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets: [5, 0] });
  });

  it("never reminds for deposited rows", async () => {
    const april = await depositRow("2026-04-01");
    expect(april!.status).toBe("deposited");
    // April was due 2026-05-15 — replaying that date must not fire for it.
    const res = await sendDepositReminders({ db: t.db, config: t.config }, { today: "2026-05-15" });
    expect(res.sent).toBe(0);
  });
});
