/**
 * PAY-22 regression tests — the in-progress-year 940 filing row. Root cause
 * was syncAnnualFilings skipping any year whose Dec 31 >= today, so no 940
 * row (the FUTA deposit-liability monitor) existed until January. The sync
 * now creates the current-year 940 as not_started with a live worksheet and
 * promotes it to ready on Jan 1 of the following year — the same gate as
 * W-2 availability (w2AvailableOn). The w2_w3 row intentionally stays
 * year-close-only: W-2s are never furnished before year-end.
 *
 * Fixture (real SQL via the PGlite harness; config through the audited admin
 * PUT, runs through generate/approve/issue):
 * - 2030: two employees at $8,000/mo, suta_credit_rate = 0 → $420/employee.
 * - 2031: same employees, default 5.4% credit → $42/employee.
 * - 2032: two employees at $350/mo, credit 0 → $21/mo each; cumulative
 *   liability $378 after Q3 (≤ $500) and $504 after Q4 — a Q4 crossing whose
 *   deposit due date lands in the FOLLOWING year (the year-boundary case).
 *
 * Runs for all three years exist up front; the sync's fake `today` decides
 * which years are in-progress vs closed for each assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  company,
  compensation,
  emailOutbox,
  employees,
  type payrollRuns,
  seedDatabase,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { TAX_CONFIG } from "@payroll/engine";
import {
  annualDueDate,
  compute940Worksheet,
  syncAnnualFilings,
  type Worksheet940,
} from "../src/filings/annual.js";
import { getFilingDetail, markFiled, sendFilingReminders } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;
let adminUserId: string;
const mainEmployeeIds: number[] = [];
const boundaryEmployeeIds: number[] = [];

/** Full scalar config for a year, derived from the vendored 2026 constants. */
function scalarConfig(sutaCreditRate: number) {
  return {
    standardDeduction: TAX_CONFIG.standardDeduction,
    socialSecurityRate: TAX_CONFIG.socialSecurityRate,
    socialSecurityWageCap: TAX_CONFIG.socialSecurityWageCap,
    medicareRate: TAX_CONFIG.medicareRate,
    medicareAdditionalRate: TAX_CONFIG.medicareAdditionalRate,
    medicareAdditionalThreshold: TAX_CONFIG.medicareAdditionalThreshold,
    stateWithholdingRate: 0,
    employerSocialSecurityRate: TAX_CONFIG.employerSocialSecurityRate,
    employerMedicareRate: TAX_CONFIG.employerMedicareRate,
    sutaCreditRate,
    futaWageCap: TAX_CONFIG.futaWageCap,
  };
}

/** Zero-withholding brackets keep the fixture arithmetic FUTA-only. */
const ZERO_BRACKET = [{ ordinal: 1, minAmount: 0, maxAmount: null, rate: 0 }];

async function putTaxConfig(taxYear: number, sutaCreditRate: number) {
  const res = await t.app.inject({
    method: "PUT",
    url: "/api/admin/tax-config",
    headers: ADMIN,
    payload: {
      jurisdiction: "federal",
      taxYear,
      config: scalarConfig(sutaCreditRate),
      brackets: ZERO_BRACKET,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Generate → approve → issue one monthly run (the filings.test.ts pattern). */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error(`no run generated: ${gen.body}`);
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

async function addEmployee(legalName: string, hireDate: string, monthly: number): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: companyRows[0]?.id ?? 1, legalName, hireDate })
    .returning();
  const id = rows[0]?.id;
  if (!id) throw new Error("employee insert failed");
  await t.db.insert(compensation).values({
    employeeId: id,
    periodAmount: String(monthly),
    frequency: "monthly",
    effectiveFrom: hireDate,
    effectiveTo: null,
  });
  return id;
}

/** The stored annual filing row (any status) for one form/year. */
async function filingRow(formType: "940" | "w2_w3", year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, formType), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    )
    .limit(1);
  return rows[0];
}

function worksheet940(row: Awaited<ReturnType<typeof filingRow>>): Worksheet940 {
  if (!row?.worksheet) throw new Error("filing row has no worksheet");
  return row.worksheet as Worksheet940;
}

async function sync(today: string) {
  return syncAnnualFilings({ db: t.db, config: t.config }, { today });
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "inyear-admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  // Main pair: $8,000/mo — FUTA cap reached in January, $420/$42 per employee.
  for (const name of ["Inyear One", "Inyear Two"]) {
    mainEmployeeIds.push(await addEmployee(name, "2030-01-01", 8_000));
  }
  // Boundary pair: $350/mo, never hits the cap — liability accrues all year.
  for (const name of ["Boundary One", "Boundary Two"]) {
    boundaryEmployeeIds.push(await addEmployee(name, "2032-01-01", 350));
  }

  // Each year's credit is configured BEFORE that year's runs issue.
  await putTaxConfig(2030, 0); // no SUTA paid → statutory 6.0%
  for (const employeeId of mainEmployeeIds) await issueRun(employeeId, 2030, 1);

  await putTaxConfig(2031, 0.054); // full credit → 0.6%
  for (const employeeId of mainEmployeeIds) await issueRun(employeeId, 2031, 1);

  await putTaxConfig(2032, 0);
  for (let month = 1; month <= 9; month++) {
    for (const employeeId of boundaryEmployeeIds) await issueRun(employeeId, 2032, month);
  }
}, 180_000);

afterAll(async () => {
  await t.close();
});

describe("in-year 940 row (PAY-22)", () => {
  it("creates the current-year 940 as not_started with a live worksheet at 6% (credit 0)", async () => {
    await sync("2030-06-15");

    const row = await filingRow("940", 2030);
    expect(row).toBeDefined();
    expect(row?.status).toBe("not_started");
    expect(row?.dueDate).toBe(annualDueDate(2030)); // 2031-01-31 (Friday)
    expect(row?.createdBy).toBe("scheduler");

    const w = worksheet940(row);
    expect(w.sutaCreditRate).toBe("0");
    expect(w.futaRate).toBe("0.06");
    expect(w.line7FutaTaxableWages).toBe("14000.00"); // 2 × $7,000 cap
    expect(w.line8FutaTax).toBe("840.00"); // 2 × $420
    expect(w.futaTaxPerFrozenEntries).toBe("840.00");
    expect(w.roundingDelta).toBe("0.00");
    // Deposit section is live in-year: $840 crossed $500 back in Q1.
    expect(w.depositThresholdCrossedQuarter).toBe(1);
    expect(w.depositDueBy).toBe("2030-04-30");
  });

  it("does NOT create an in-year w2_w3 row — W-2s are never furnished before year-end", async () => {
    expect(await filingRow("w2_w3", 2030)).toBeUndefined();
    expect(await filingRow("w2_w3", 2031)).toBeUndefined();
    expect(await filingRow("w2_w3", 2032)).toBeUndefined();
  });

  it("default 5.4% credit → $42 per employee on the in-year worksheet", async () => {
    const row = await filingRow("940", 2031);
    expect(row?.status).toBe("not_started");
    const w = worksheet940(row);
    expect(w.sutaCreditRate).toBe("0.054");
    expect(w.futaRate).toBe("0.006");
    expect(w.line8FutaTax).toBe("84.00"); // 2 × $42
    expect(w.depositThresholdCrossedQuarter).toBeNull(); // $84 ≤ $500
    expect(w.depositDueBy).toBeNull();
  });

  it("deposit section tracks the running liability; a Q4 crossing lands in the following year", async () => {
    // Nine months issued: $21/mo × 2 employees × 9 = $378 — no crossing yet.
    const before = worksheet940(await filingRow("940", 2032));
    expect(before.futaTaxPerFrozenEntries).toBe("378.00");
    expect(before.depositThresholdCrossedQuarter).toBeNull();
    expect(before.depositDueBy).toBeNull();

    // The crossing surfaces the moment Q4 liability accrues.
    for (let month = 10; month <= 12; month++) {
      for (const employeeId of boundaryEmployeeIds) await issueRun(employeeId, 2032, month);
    }
    await sync("2032-12-15");

    const row = await filingRow("940", 2032);
    expect(row?.status).toBe("not_started"); // 2032 still in progress
    const w = worksheet940(row);
    expect(w.futaTaxPerFrozenEntries).toBe("504.00"); // 378 + 126
    expect(w.line8FutaTax).toBe("504.00"); // 2 × $4,200 wages × 6%
    expect(w.roundingDelta).toBe("0.00");
    expect(w.depositThresholdCrossedQuarter).toBe(4);
    // Year boundary: a Q4 crossing is due Jan 31 of the NEXT year.
    expect(w.depositDueBy).toBe("2033-01-31");
  });

  it("refreshes-on-read: the unfiled in-year worksheet is never stale", async () => {
    const row = await filingRow("940", 2032);
    if (!row) throw new Error("2032 940 row missing");
    await t.db
      .update(taxFilings)
      .set({ worksheetHash: "stale", updatedAt: new Date() })
      .where(eq(taxFilings.id, row.id));

    const { filing } = await getFilingDetail(t.db, row.id);
    expect(filing.worksheetHash).not.toBe("stale");
    expect(filing.worksheet).toEqual(await compute940Worksheet(t.db, 2032));
  });

  it("transitions not_started → ready on Jan 1; filed rows are untouched", async () => {
    // The 2032-12-15 sync above already closed 2030/2031 (both < today):
    // promoted to ready, and their w2_w3 rows now exist.
    expect((await filingRow("940", 2031))?.status).toBe("ready");
    expect((await filingRow("w2_w3", 2031))?.status).toBe("ready");

    // Dec 31 of the year itself: still in progress.
    await sync("2032-12-31");
    expect((await filingRow("940", 2032))?.status).toBe("not_started");
    expect(await filingRow("w2_w3", 2032)).toBeUndefined();

    // File the 2032 940 while still not_started (early filing is allowed),
    // then close the year: the filed row must not be promoted or refreshed.
    const row2032 = await filingRow("940", 2032);
    if (!row2032) throw new Error("2032 940 row missing");
    const filed = await markFiled(
      { db: t.db, config: t.config },
      row2032.id,
      { filedOn: "2032-12-20", filingMethod: "IRS e-file", filingReference: "EF-2032" },
      adminUserId,
    );
    expect(filed.status).toBe("filed");

    await sync("2033-01-01");
    const after = await filingRow("940", 2032);
    expect(after?.status).toBe("filed"); // never demoted/promoted
    expect(after?.worksheetHash).toBe(row2032.worksheetHash); // frozen
    expect((await filingRow("w2_w3", 2032))?.status).toBe("ready"); // appears at close
  });

  it("reminders key off due-date proximity, not row existence — nothing fires before January", async () => {
    const row2030 = await filingRow("940", 2030);
    const row2030w3 = await filingRow("w2_w3", 2030);
    if (!row2030 || !row2030w3) throw new Error("2030 filing rows missing");

    // Mid-year and even Dec 31: the rows exist (not_started, then ready) but
    // their due date (2031-01-31) is beyond the max 30-day reminder offset.
    for (const today of ["2030-06-15", "2030-12-31"]) {
      const { sent } = await sendFilingReminders({ db: t.db, config: t.config }, { today });
      expect(sent).toBe(0);
    }
    const earlyMail = await t.db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(
        sql`${emailOutbox.bodyHtml} LIKE ${`%filing-reminder:${row2030.id}:%`} OR ${emailOutbox.bodyHtml} LIKE ${`%filing-reminder:${row2030w3.id}:%`}`,
      );
    expect(earlyMail).toHaveLength(0);

    // Inside the January window the reminder does fire — exactly once per
    // filing (the 940 and w2_w3 share the Jan 31 due date → 2 sends).
    expect(row2030.dueDate).toBe("2031-01-31");
    const fireDay = "2031-01-17"; // due − 14 (the largest default offset)
    const first = await sendFilingReminders({ db: t.db, config: t.config }, { today: fireDay });
    expect(first.sent).toBe(2);
    const dupe = await sendFilingReminders({ db: t.db, config: t.config }, { today: fireDay });
    expect(dupe.sent).toBe(0);
  });
});
