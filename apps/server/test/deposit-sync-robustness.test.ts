/**
 * PAY-91 fix round 1 (A): one state unit with bad data never stops the
 * federal sync or the other states, is reported once per day, and never 500s
 * the deposit pages. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { failureCode, syncDeposits } from "../src/deposits/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "pay91-robust@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
}, 180_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pglite.exec(
    `TRUNCATE tax_deposits, payroll_entries, payroll_runs, email_outbox RESTART IDENTITY CASCADE;
     DELETE FROM audit_events WHERE action = 'tax_deposit.sync_failed';
     DROP TRIGGER IF EXISTS pay91_fail_ca_insert ON tax_deposits;`,
  );
});

async function employee(name: string): Promise<number> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: c[0]!.id, legalName: name, hireDate: "2025-01-01" })
    .returning();
  return rows[0]!.id;
}

async function run(emp: number, state: string, payDate: string, swh: string): Promise<void> {
  const r = await t.pglite.query<{ id: number }>(
    `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
     VALUES ($1, $2, $3, $4, 'issued', $5::jsonb, now()) RETURNING id`,
    [
      emp,
      `${payDate.slice(0, 7)}-01`,
      `${payDate.slice(0, 7)}-28`,
      payDate,
      JSON.stringify({ inputs: { state: { workState: state } } }),
    ],
  );
  const id = r.rows[0]!.id;
  await t.pglite.query(
    `INSERT INTO payroll_entries (run_id, category, amount) VALUES ($1, 'federal_withholding', '50.00'), ($1, 'state_withholding', $2)`,
    [id, swh],
  );
}

async function count(sqlText: string): Promise<number> {
  return (await t.pglite.query<{ n: number }>(sqlText)).rows[0]!.n;
}

async function setup(): Promise<number> {
  // IL: a July row already exists; an August run carries a NEGATIVE state
  // withholding entry, so IL Q3 2026 is a data error. CA is healthy.
  const il = await t.pglite.query<{ id: number }>(
    `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, created_by)
     VALUES ('IL', '2026-07-01', '40.00', '2026-08-17', 'pending', 'scheduler') RETURNING id`,
  );
  const a = await employee("Ada Robust");
  const b = await employee("Bob Robust");
  await run(a, "IL", "2026-07-15", "40.00");
  await run(a, "IL", "2026-08-14", "-90.00");
  await run(b, "CA", "2026-07-15", "60.00");
  return il.rows[0]!.id;
}

describe("PAY-91 bad state data", () => {
  it("skips only the bad unit: federal + other states synced, no IL row written, no clamping", async () => {
    await setup();
    const res = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-08-20" });
    expect(res.failedUnits).toBe(1);
    const r = await t.pglite.query<{ j: string; start: string; amount: string }>(
      `SELECT jurisdiction AS j, period_start::text AS start, amount::text AS amount
         FROM tax_deposits WHERE status <> 'superseded' ORDER BY jurisdiction, period_start`,
    );
    expect(r.rows.map((x) => `${x.j} ${x.start} ${x.amount}`)).toEqual([
      "CA 2026-07-01 60.00",
      "IL 2026-07-01 40.00", // untouched, not recomputed, no August row
      "federal 2026-07-01 100.00",
      "federal 2026-08-01 50.00",
    ]);
    expect(await count(`SELECT count(*)::int AS n FROM tax_deposits WHERE amount < 0`)).toBe(0);
  });

  it("records one audit event and one admin mail per failed unit per day", async () => {
    await setup();
    const deps = { db: t.db, config: t.config };
    await syncDeposits(deps, { today: "2026-08-20" });
    await syncDeposits(deps, { today: "2026-08-20" });
    const audit = await t.pglite.query<{ entity_id: string; after: { day: string; code: string } }>(
      `SELECT entity_id, after FROM audit_events WHERE action = 'tax_deposit.sync_failed'`,
    );
    expect(audit.rows).toEqual([
      { entity_id: "IL:2026-Q3", after: { day: "2026-08-20", code: "invalid_amount" } },
    ]);
    const admins = await count(
      `SELECT count(*)::int AS n FROM "user" WHERE role = 'admin' AND coalesce(banned, false) = false`,
    );
    const mails = await t.pglite.query<{ subject: string; body_html: string }>(
      `SELECT subject, body_html FROM email_outbox WHERE event_type = 'tax_deposit_sync_failed'`,
    );
    expect(mails.rows).toHaveLength(admins);
    expect(mails.rows[0]!.subject).toContain("Illinois tax deposits for Q3 2026 need checking");
    expect(mails.rows[0]!.body_html).toContain(
      "Until this is fixed, the Illinois amount for Q3 2026 may not be right. Check it before you pay.",
    );
    expect(mails.rows[0]!.body_html).toContain('/admin/deposits"');
    expect(mails.rows[0]!.body_html).not.toContain("<!--");
    expect(mails.rows[0]!.body_html).not.toContain("90.00");
    // Next day: reported again, once.
    await syncDeposits(deps, { today: "2026-08-21" });
    expect(
      await count(
        `SELECT count(*)::int AS n FROM email_outbox WHERE event_type = 'tax_deposit_sync_failed'`,
      ),
    ).toBe(admins * 2);
  });

  it("list and detail still return 200 and flag the unit", async () => {
    const ilId = await setup();
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-08-20" });
    const list = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-deposits",
      headers: ADMIN,
    });
    expect(list.statusCode, list.body).toBe(200);
    const rows = (
      list.json() as {
        deposits: { id: number; jurisdiction: string; paymentsUnavailable: boolean }[];
      }
    ).deposits;
    expect(rows.find((d) => d.id === ilId)?.paymentsUnavailable).toBe(true);
    expect(rows.find((d) => d.jurisdiction === "CA")?.paymentsUnavailable).toBe(false);
    const detail = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${ilId}`,
      headers: ADMIN,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const d = detail.json() as {
      paymentsUnavailable: boolean;
      credits: unknown[];
      overpaid: string;
    };
    expect([d.paymentsUnavailable, d.credits, d.overpaid]).toEqual([true, [], "0.00"]);
  });

  it("two concurrent syncs alert once (the report runs under the advisory lock)", async () => {
    await setup();
    const deps = { db: t.db, config: t.config };
    await Promise.all([
      syncDeposits(deps, { today: "2026-08-20" }),
      syncDeposits(deps, { today: "2026-08-20" }),
    ]);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'tax_deposit.sync_failed'`,
      ),
    ).toBe(1);
  });
});

describe("PAY-91 DB error after a partial unit write", () => {
  it("rolls the unit back to its savepoint; other units and federal still commit", async () => {
    // CA: v1.24 month rows + quarterly schedule -> the plan supersedes the
    // month rows, THEN inserts the quarter row. A trigger makes that insert
    // fail with a unique violation, after the supersede UPDATE ran.
    await t.pglite.exec(`
      DELETE FROM state_deposit_schedules WHERE state_code IN ('CA','NY') AND tax_year = 2026;
      INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day)
        VALUES ('CA', 2026, 'quarterly', NULL), ('NY', 2026, 'quarterly', NULL);
      INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, created_by)
        VALUES ('CA', '2026-07-01', '60.00', '2026-08-17', 'overdue', 'scheduler'),
               ('CA', '2026-08-01', '60.00', '2026-09-15', 'pending', 'scheduler');
      CREATE OR REPLACE FUNCTION pay91_fail_ca_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.jurisdiction = 'CA' THEN
          RAISE EXCEPTION 'forced' USING ERRCODE = 'unique_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pay91_fail_ca_insert BEFORE INSERT ON tax_deposits
        FOR EACH ROW EXECUTE FUNCTION pay91_fail_ca_insert();
    `);
    const a = await employee("Cy Partial");
    const b = await employee("Di Partial");
    await run(a, "CA", "2026-07-15", "60.00");
    await run(a, "CA", "2026-08-14", "60.00");
    await run(b, "NY", "2026-07-15", "80.00");
    const res = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-09-10" });
    expect(res.failedUnits).toBe(1);
    const r = await t.pglite.query<{ s: string }>(
      `SELECT jurisdiction || ' ' || period_kind || ' ' || period_start || ' ' || amount || ' ' || status AS s
         FROM tax_deposits ORDER BY jurisdiction, period_start, period_kind`,
    );
    expect(r.rows.map((x) => x.s)).toEqual([
      // CA untouched: the supersede was rolled back with the failed insert.
      "CA month 2026-07-01 60.00 overdue",
      "CA month 2026-08-01 60.00 pending",
      "NY quarter 2026-07-01 80.00 pending",
      "federal month 2026-07-01 100.00 overdue",
      "federal month 2026-08-01 50.00 pending",
    ]);
    const audit = await t.pglite.query<{ entity_id: string; code: string }>(
      `SELECT entity_id, after->>'code' AS code FROM audit_events WHERE action = 'tax_deposit.sync_failed'`,
    );
    expect(audit.rows).toEqual([{ entity_id: "CA:2026-Q3", code: "sqlstate_23505" }]);
  });
});

describe("failureCode", () => {
  it("never returns a message: planner code, SQLSTATE (also via cause), or class name", () => {
    expect(failureCode(Object.assign(new Error("amount 12.34 bad"), { code: "23505" }))).toBe(
      "sqlstate_23505",
    );
    expect(failureCode(new Error("wrap", { cause: { code: "40P01", detail: "x" } }))).toBe(
      "sqlstate_40P01",
    );
    expect(failureCode(new TypeError("row 7 amount 9.99"))).toBe("error_TypeError");
    expect(failureCode("string thrown")).toBe("unexpected_error");
  });
});
