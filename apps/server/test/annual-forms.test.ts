/**
 * PAY-11 integration tests — annual forms: Form 940 (FUTA) worksheet + W-2/W-3
 * generation and filing tracking. Real SQL via the PGlite harness; sync and
 * reminder functions are called directly (pg-boss needs a real Postgres), the
 * admin/employee routes go through app.inject with real sessions.
 *
 * Fixture (built once in beforeAll): thirteen W-2 employees with issued 2025
 * runs — twelve at $8,000/mo (January only; FUTA-capped at $7,000, enough to
 * cross the $500 quarterly deposit threshold in Q1) and one at $1,111.11/mo
 * for the full year (exercises the per-paycheck FUTA rounding delta). Two of
 * the capped employees are linked to real user accounts (W-2 self-service +
 * availability notices). The rounding employee also has a January 2026 run so
 * "year not ended / W-2 not yet available" branches are exercised. A
 * contractor with a (legacy-style, direct-insert) issued run proves the
 * employment_type='w2' joins exclude contractors everywhere.
 *
 * Covers: annual due-date math (weekend roll), the 940 worksheet line-by-line
 * with reconciliation to the cent against frozen entries + the export API +
 * the sum of quarterly 941 worksheets, W-2 box figures and the W-3 aggregate,
 * PDF content (PII + full figures in the rendered document, never in JSON),
 * the January availability gate, sync (create/refresh/freeze), admin +
 * employee routes incl. RBAC, tax_filing_due reminders for annual rows, and
 * the once-per-year w2_available notices.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  appSettings,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE } from "@payroll/notifications";
import { buildW2Doc, buildW3Doc, renderW2Pdf } from "@payroll/documents";
import { computeWorksheet, sendFilingReminders } from "../src/filings/service.js";
import {
  annualDueDate,
  compute940Worksheet,
  computeW3Worksheet,
  isW2Available,
  sendW2AvailableNotices,
  syncAnnualFilings,
  w2AvailableOn,
  w2FiguresForYear,
  w2InputFor,
  w3InputFor,
  type Worksheet940,
  type WorksheetW3,
} from "../src/filings/annual.js";
import { worksheetHash } from "../src/filings/shared.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const EXPORT_TOKEN = "test-export-token-0123456789abcdef";

let t: TestContext;
let ADMIN: Record<string, string>;
/** Account-linked employee (January 2025 run) — self-service fixture. */
let acctA: { userId: string; email: string; employeeId: number };
let contractorUser: { userId: string; email: string };
let contractorEmployeeId: number;
/** All thirteen 2025 W-2 fixture employee ids (pre late-run). */
const fixtureEmployeeIds: number[] = [];

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "annual-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  // Ten plain capped employees + two account-linked ones, $8,000/mo, Jan 2025.
  for (let i = 1; i <= 10; i += 1) {
    const id = await createEmployee(`Annual Cap ${String(i).padStart(2, "0")}`);
    await addCompensation(id, 8000);
    await issueRun(id, 2025, 1);
    fixtureEmployeeIds.push(id);
  }
  for (const [email, name] of [
    ["annual-acct-a@test.dev", "Annual Acct A"],
    ["annual-acct-b@test.dev", "Annual Acct B"],
  ] as const) {
    const user = await inviteAndOnboard(t, { email, name });
    const id = await createEmployee(name, { userId: user.userId });
    await addCompensation(id, 8000);
    await issueRun(id, 2025, 1);
    fixtureEmployeeIds.push(id);
    if (email.endsWith("-a@test.dev")) acctA = { userId: user.userId, email, employeeId: id };
  }

  // Rounding employee: $1,111.11/mo all of 2025 (per-paycheck FUTA rounding
  // delta) + January 2026 (a year that has NOT ended / W-2 not available).
  const rounding = await createEmployee("Annual Rounding");
  await addCompensation(rounding, 1111.11);
  for (let month = 1; month <= 12; month += 1) await issueRun(rounding, 2025, month);
  await issueRun(rounding, 2026, 1);
  fixtureEmployeeIds.push(rounding);

  // A contractor (1099) with a user account — never a W-2 recipient.
  contractorUser = await inviteAndOnboard(t, {
    email: "annual-contractor@test.dev",
    name: "Annual Contractor",
  });
  contractorEmployeeId = await createEmployee("Annual Contractor", {
    userId: contractorUser.userId,
    employmentType: "1099",
  });
}, 240_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createEmployee(
  legalName: string,
  opts: { userId?: string; employmentType?: string } = {},
): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate: "2025-01-01",
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.employmentType ? { employmentType: opts.employmentType } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
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

/** Generate → approve → issue a monthly run (the filings.test.ts pattern). */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error("no run generated");
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

async function api(
  method: "GET" | "POST" | "PUT" | "DELETE",
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

/** Sum one entry category for the year — W-2 employees only (mirrors production). */
async function categorySum(year: number, category: string): Promise<number> {
  const rows = await t.db
    .select({
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, category),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    );
  return Number(rows[0]?.total ?? "0");
}

/** Per-employee sum of one category (W-2 only), keyed by employee id. */
async function perEmployeeCategory(year: number, category: string): Promise<Map<number, number>> {
  const rows = await t.db
    .select({
      employeeId: payrollRuns.employeeId,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, category),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(payrollRuns.employeeId);
  return new Map(rows.map((r) => [r.employeeId, Number(r.total)]));
}

async function annualFilingRow(formType: "940" | "w2_w3", year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, formType), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

/** A legacy-style issued contractor run (direct insert — the service layer hard-blocks these). */
async function insertContractorLegacyRun(): Promise<void> {
  const snapshot: RunSnapshot = {
    inputs: {
      periodAmount: 5000,
      frequency: "monthly",
      periodsPerYear: 12,
      w4: null,
      taxConfig: {
        jurisdiction: "federal",
        taxYear: 2025,
        standardDeduction: 15000,
        socialSecurityRate: 0.062,
        socialSecurityWageCap: 176100,
        medicareRate: 0.0145,
        medicareAdditionalRate: 0.009,
        medicareAdditionalThreshold: 200000,
        stateWithholdingRate: 0,
        employerSocialSecurityRate: 0.062,
        employerMedicareRate: 0.0145,
        futaRate: 0.006,
        futaWageCap: 7000,
      },
      brackets: [],
      priorYtdGross: 0,
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      payDate: "2025-02-15",
      company: { legalName: "Example Corp" },
      employee: { legalName: "Annual Contractor", preferredName: null },
    },
    result: {
      grossPay: 5000,
      federalWithholding: 0,
      socialSecurity: 0,
      medicare: 0,
      stateWithholding: 0,
      totalDeductions: 0,
      netPay: 5000,
      employerSocialSecurity: 0,
      employerMedicare: 0,
      employerFUTA: 30,
      totalEmployerCost: 5030,
      ytdGross: 5000,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.1.0",
  };
  const inserted = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: contractorEmployeeId,
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      payDate: "2025-02-15",
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: "legacy-import",
    })
    .returning();
  const runId = inserted[0]?.id;
  if (!runId) throw new Error("contractor run insert failed");
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: "5000.00" },
    { runId, category: "federal_withholding", amount: "0.00" },
    { runId, category: "social_security", amount: "0.00" },
    { runId, category: "medicare", amount: "0.00" },
    { runId, category: "state_withholding", amount: "0.00" },
    { runId, category: "net_pay", amount: "5000.00" },
    { runId, category: "employer_social_security", amount: "0.00" },
    { runId, category: "employer_medicare", amount: "0.00" },
    { runId, category: "employer_futa", amount: "30.00" },
  ]);
}

// ---------------------------------------------------------------------------
// Pure date math
// ---------------------------------------------------------------------------

describe("annualDueDate + W-2 availability (PAY-11 domain rules)", () => {
  it("is Jan 31 of the following year, weekend-rolled", () => {
    expect(annualDueDate(2024)).toBe("2025-01-31"); // Friday — no roll
    expect(annualDueDate(2025)).toBe("2026-02-02"); // Jan 31 2026 is a Saturday
    expect(annualDueDate(2026)).toBe("2027-02-01"); // Jan 31 2027 is a Sunday
  });

  it("W-2s unlock on January 1 of the following year", () => {
    expect(w2AvailableOn(2025)).toBe("2026-01-01");
    expect(isW2Available(2025, "2025-12-31")).toBe(false);
    expect(isW2Available(2025, "2026-01-01")).toBe(true);
    expect(isW2Available(2026, "2026-12-31")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Form 940 worksheet — deterministic, reconciles to the cent
// ---------------------------------------------------------------------------

describe("compute940Worksheet", () => {
  it("computes all lines from frozen entries; reconciles three ways", async () => {
    const w = await compute940Worksheet(t.db, 2025);

    // Line 3 — total payments: 12 × $8,000 + 12 × $1,111.11.
    expect(w.line3TotalPayments).toBe("109333.32");
    // Line 7 — every fixture employee exceeds the $7,000 FUTA cap.
    expect(w.line7FutaTaxableWages).toBe("91000.00"); // 13 × 7,000
    expect(w.line8FutaTax).toBe("546.00"); // 91,000 × 0.6%
    expect(w.line12TotalFutaTax).toBe("546.00"); // full state credit, no reduction

    // Frozen-entry truth (accrued liability): the DB sum of employer_futa.
    // 12 × 42.00 (capped month 1) + the rounding employee's 42.02.
    const futaEntries = await categorySum(2025, "employer_futa");
    expect(w.futaTaxPerFrozenEntries).toBe(futaEntries.toFixed(2));
    expect(futaEntries.toFixed(2)).toBe("546.02");

    // Rounding delta (941 line-7 doctrine): frozen entries − line 12, to the cent.
    const delta = round2(futaEntries - Number(w.line12TotalFutaTax));
    expect(w.roundingDelta).toBe(delta.toFixed(2));
    expect(delta.toFixed(2)).toBe("0.02"); // per-paycheck rounding, non-zero by fixture design

    // $500 quarterly deposit rule: 12 × 42.00 + 6.67 = $510.67 in Q1 → crossed.
    expect(w.depositThresholdCrossedQuarter).toBe(1);
    expect(w.depositDueBy).toBe("2025-04-30"); // last day of month after Q1

    // Balance due = frozen-entry truth (no FUTA deposits tracked in-app).
    expect(w.balanceDue).toBe(w.futaTaxPerFrozenEntries);

    // Reconciliation 1: 940 line 3 == sum of the year's quarterly 941 line 2.
    let sum941 = 0;
    for (const quarter of [1, 2, 3, 4]) {
      const q = await computeWorksheet(t.db, 2025, quarter);
      sum941 = round2(sum941 + Number(q.line2Wages));
    }
    expect(w.line3TotalPayments).toBe(sum941.toFixed(2));

    // Reconciliation 2: frozen FUTA entries == the export API's figures.
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs?from=2025-01-01&to=2025-12-31",
      headers: { authorization: `Bearer ${EXPORT_TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { runs } = res.json() as { runs: { entries: Record<string, string | null> }[] };
    const exportFuta = round2(
      runs.reduce((acc, r) => acc + Number(r.entries.employer_futa ?? "0"), 0),
    );
    expect(w.futaTaxPerFrozenEntries).toBe(exportFuta.toFixed(2));
  });

  it("snapshot hash is stable across recomputation with the same inputs", async () => {
    const w1 = await compute940Worksheet(t.db, 2025);
    const w2 = await compute940Worksheet(t.db, 2025);
    expect(worksheetHash(w1)).toBe(worksheetHash(w2));
  });

  it("an empty year yields zeros and no deposit obligation", async () => {
    const w = await compute940Worksheet(t.db, 2020);
    expect(w.line3TotalPayments).toBe("0.00");
    expect(w.line7FutaTaxableWages).toBe("0.00");
    expect(w.line12TotalFutaTax).toBe("0.00");
    expect(w.futaTaxPerFrozenEntries).toBe("0.00");
    expect(w.roundingDelta).toBe("0.00");
    expect(w.depositThresholdCrossedQuarter).toBeNull();
    expect(w.depositDueBy).toBeNull();
    expect(w.balanceDue).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// W-2 figures + W-3 aggregate — contractors excluded everywhere
// ---------------------------------------------------------------------------

describe("W-2 figures and the W-3 worksheet", () => {
  it("computes the six boxes per employee; contractors never appear", async () => {
    // A legacy-style contractor run (direct insert — service blocks these)
    // must not leak into any annual-form figure.
    await insertContractorLegacyRun();

    const figures = await w2FiguresForYear(t.db, 2025);
    expect(figures).toHaveLength(13);
    expect(figures.some((f) => f.employeeId === contractorEmployeeId)).toBe(false);

    const gross = await perEmployeeCategory(2025, "gross_pay");
    const fed = await perEmployeeCategory(2025, "federal_withholding");
    const ss = await perEmployeeCategory(2025, "social_security");
    const medicare = await perEmployeeCategory(2025, "medicare");
    const byId = new Map(figures.map((f) => [f.employeeId, f]));
    for (const [employeeId, box1] of gross) {
      const f = byId.get(employeeId);
      if (!f) throw new Error(`missing W-2 figures for employee ${employeeId}`);
      expect(f.box1Wages).toBe(box1);
      expect(f.box2FederalWithheld).toBe(round2(fed.get(employeeId) ?? 0));
      // Box 3 applies the 2025 SS wage cap ($176,100 — nobody here reaches it).
      expect(f.box3SsWages).toBe(round2(Math.min(box1, 176_100)));
      expect(f.box4SsTax).toBe(round2(ss.get(employeeId) ?? 0));
      expect(f.box5MedicareWages).toBe(box1); // Medicare wages are uncapped
      expect(f.box6MedicareTax).toBe(round2(medicare.get(employeeId) ?? 0));
    }

    // W-3 = the box-by-box aggregate across all W-2s.
    const w3 = await computeW3Worksheet(t.db, 2025);
    expect(w3.employeeCount).toBe(13);
    const sum = (pick: (f: (typeof figures)[number]) => number) =>
      round2(figures.reduce((acc, f) => acc + pick(f), 0)).toFixed(2);
    expect(w3.box1Wages).toBe(sum((f) => f.box1Wages));
    expect(w3.box2FederalWithheld).toBe(sum((f) => f.box2FederalWithheld));
    expect(w3.box3SsWages).toBe(sum((f) => f.box3SsWages));
    expect(w3.box4SsTax).toBe(sum((f) => f.box4SsTax));
    expect(w3.box5MedicareWages).toBe(sum((f) => f.box5MedicareWages));
    expect(w3.box6MedicareTax).toBe(sum((f) => f.box6MedicareTax));
    // The contractor's $5,000 legacy gross is excluded from the aggregate.
    expect(w3.box1Wages).toBe("109333.32");
  });
});

// ---------------------------------------------------------------------------
// W-2/W-3 PDFs — full figures + PII in the document, render-time only
// ---------------------------------------------------------------------------

describe("W-2/W-3 PDF rendering", () => {
  it("assembles the W-2 input with PII decrypted at render time", async () => {
    await t.db
      .update(company)
      .set({
        ein: encryptField("12-3456789", t.config.encryptionKey),
        address: { line1: "100 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" },
      })
      .where(eq(company.id, 1));
    await t.db
      .update(employees)
      .set({
        taxId: encryptField("123456789", t.config.encryptionKey),
        address: {
          line1: "1 Infinite Loop",
          line2: "Apt 4",
          city: "Cupertino",
          state: "CA",
          zip: "95014",
          country: "US",
        },
      })
      .where(eq(employees.id, acctA.employeeId));

    const input = await w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2025);
    expect(input.taxYear).toBe(2025);
    expect(input.employer.legalName).toBe("Example Corp");
    expect(input.employer.ein).toBe("12-3456789");
    expect(input.employee.ssn).toBe("123-45-6789"); // 9 stored digits → ###-##-####
    expect(input.employee.legalName).toBe("Annual Acct A");
    expect(input.box1Wages).toBe(8000);

    // The rendered document carries the full figures + PII (the official copy).
    const doc = JSON.stringify(buildW2Doc(input));
    expect(doc).toContain("FORM W-2");
    expect(doc).toContain("Tax Year: 2025");
    expect(doc).toContain("Example Corp");
    expect(doc).toContain("EIN: 12-3456789");
    expect(doc).toContain("100 Main St");
    expect(doc).toContain("Austin, TX 78701");
    expect(doc).toContain("Annual Acct A");
    expect(doc).toContain("SSN: 123-45-6789");
    expect(doc).toContain("1 Infinite Loop");
    expect(doc).toContain("Apt 4");
    expect(doc).toContain("Cupertino, CA 95014");
    const usd = (n: number) =>
      n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(doc).toContain(usd(input.box1Wages));
    expect(doc).toContain(usd(input.box2FederalWithheld));
    expect(doc).toContain(usd(input.box3SsWages));
    expect(doc).toContain(usd(input.box4SsTax));
    expect(doc).toContain(usd(input.box5MedicareWages));
    expect(doc).toContain(usd(input.box6MedicareTax));

    const pdf = await renderW2Pdf(input);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders the W-3 transmittal with the aggregate and the count", async () => {
    const input = await w3InputFor({ db: t.db, config: t.config }, 2025);
    expect(input.taxYear).toBe(2025);
    expect(input.employeeCount).toBe(13);
    expect(input.box1Wages).toBe(109333.32);
    const doc = JSON.stringify(buildW3Doc(input));
    expect(doc).toContain("FORM W-3");
    expect(doc).toContain("Number of W-2 statements: 13");
    expect(doc).toContain("EIN: 12-3456789");
  });

  it("enforces the availability gate and not-found rules", async () => {
    // Not yet available (explicit today; also holds for the real clock).
    await expect(
      w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2026, { today: "2026-06-01" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    // A contractor has no W-2 even with legacy runs on file.
    await expect(
      w2InputFor({ db: t.db, config: t.config }, contractorEmployeeId, 2025),
    ).rejects.toMatchObject({ code: "not_found" });
    // No issued runs in the year.
    await expect(
      w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2020),
    ).rejects.toMatchObject({ code: "not_found" });
    // W-3 for an empty year.
    await expect(w3InputFor({ db: t.db, config: t.config }, 2020)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// syncAnnualFilings — creates at year end, refreshes unfiled, freezes filed
// ---------------------------------------------------------------------------

describe("syncAnnualFilings", () => {
  it("creates quarter-0 rows with worksheets once the year has ended", async () => {
    const sync = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-01-15" });
    expect(sync.created).toBe(2); // 940 + W-2/W-3 for 2025 (2026 hasn't ended)
    expect(sync.refreshed).toBe(2); // worksheets written on creation

    for (const formType of ["940", "w2_w3"] as const) {
      const row = await annualFilingRow(formType, 2025);
      if (!row) throw new Error(`no ${formType} row`);
      expect(row.status).toBe("ready");
      expect(row.quarter).toBe(0);
      expect(row.dueDate).toBe("2026-02-02"); // weekend-rolled Jan 31
      expect(row.worksheetHash).toBe(worksheetHash(row.worksheet));
    }
    const w940 = (await annualFilingRow("940", 2025))?.worksheet as Worksheet940;
    expect(w940.line3TotalPayments).toBe("109333.32");
    const w3 = (await annualFilingRow("w2_w3", 2025))?.worksheet as WorksheetW3;
    expect(w3.employeeCount).toBe(13);
  });

  it("is idempotent and refreshes when a late run issues", async () => {
    const noop = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-01-16" });
    expect(noop).toEqual({ created: 0, refreshed: 0 });

    // A fourteenth employee's March 2025 run issues late — both annual
    // worksheets recompute (gross + boxes change; employee count changes).
    const late = await createEmployee("Annual Late");
    await addCompensation(late, 2000);
    await issueRun(late, 2025, 3);
    const refresh = await syncAnnualFilings(
      { db: t.db, config: t.config },
      { today: "2026-04-01" },
    );
    expect(refresh.created).toBe(0);
    expect(refresh.refreshed).toBe(2);

    const w940 = (await annualFilingRow("940", 2025))?.worksheet as Worksheet940;
    expect(w940.line3TotalPayments).toBe("111333.32");
    const w3 = (await annualFilingRow("w2_w3", 2025))?.worksheet as WorksheetW3;
    expect(w3.employeeCount).toBe(14);
  });

  it("never rewrites a filed worksheet", async () => {
    const row = await annualFilingRow("940", 2025);
    if (!row) throw new Error("no 940 row");
    const res = await api("POST", `/api/admin/tax-filings/${row.id}/file`, {
      filedOn: "2026-01-20",
      filingMethod: "efile",
      filingReference: "IRS-940-ACK-1",
    });
    expect(res.statusCode, res.body).toBe(200);

    const hash = (await annualFilingRow("940", 2025))?.worksheetHash;
    const sync = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-04-02" });
    expect(sync.refreshed).toBe(0); // w2_w3 unchanged too — no new runs
    expect((await annualFilingRow("940", 2025))?.worksheetHash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Admin routes — W-2 list (no PII), on-demand PDFs, RBAC
// ---------------------------------------------------------------------------

describe("admin annual-form routes", () => {
  it("lists per-employee W-2 figures without any PII", async () => {
    const res = await api("GET", "/api/admin/annual-forms/w2?year=2025");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      year: number;
      available: boolean;
      availableOn: string;
      w2s: { employeeId: number; box1Wages: number }[];
    };
    expect(body.year).toBe(2025);
    expect(body.available).toBe(true);
    expect(body.availableOn).toBe("2026-01-01");
    expect(body.w2s).toHaveLength(14);
    // Content rules: no SSN/address/EIN in the JSON channel, ever.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("12-3456789");
    expect(raw).not.toContain("Infinite Loop");
    expect(raw).not.toContain("ssn");

    const future = await api("GET", "/api/admin/annual-forms/w2?year=2099");
    expect((future.json() as { available: boolean }).available).toBe(false);

    const bad = await api("GET", "/api/admin/annual-forms/w2?year=abc");
    expect(bad.statusCode).toBe(400);
  });

  it("serves W-2 and W-3 PDFs on demand", async () => {
    const w2 = await api("GET", `/api/admin/annual-forms/w2/${acctA.employeeId}/pdf?year=2025`);
    expect(w2.statusCode, w2.body).toBe(200);
    expect(w2.headers["content-type"]).toContain("application/pdf");
    expect(w2.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const w3 = await api("GET", "/api/admin/annual-forms/w3/pdf?year=2025");
    expect(w3.statusCode, w3.body).toBe(200);
    expect(w3.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // Gated + not-found paths.
    const gated = await api("GET", `/api/admin/annual-forms/w2/${acctA.employeeId}/pdf?year=2099`);
    expect(gated.statusCode).toBe(409);
    expect(gated.json()).toMatchObject({ error: "invalid_transition" });
    const missing = await api("GET", "/api/admin/annual-forms/w2/999999/pdf?year=2025");
    expect(missing.statusCode).toBe(404);
    const noYear = await api("GET", "/api/admin/annual-forms/w3/pdf?year=2020");
    expect(noYear.statusCode).toBe(404);
  });

  it("403s non-admins", async () => {
    const session = await login(t, acctA.email, TEST_PASSWORD);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/annual-forms/w2?year=2025",
      headers: sessionHeader(session.sessionCookie),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Employee self-service routes — own W-2 only, January gate
// ---------------------------------------------------------------------------

describe("my W-2 routes", () => {
  it("lists available years and serves the PDF for the employee's own W-2", async () => {
    const session = sessionHeader((await login(t, acctA.email, TEST_PASSWORD)).sessionCookie);

    const list = await t.app.inject({ method: "GET", url: "/api/my/w2", headers: session });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ w2s: [{ year: 2025, availableOn: "2026-01-01" }] });

    const pdf = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // A year without runs 404s; a not-yet-available year 409s (no enumeration).
    const noRuns = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2020/pdf",
      headers: session,
    });
    expect(noRuns.statusCode).toBe(404);
    const gated = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2099/pdf",
      headers: session,
    });
    expect(gated.statusCode).toBe(409);
  });

  it("contractors see nothing and cannot fetch a W-2", async () => {
    const session = sessionHeader(
      (await login(t, contractorUser.email, TEST_PASSWORD)).sessionCookie,
    );
    const list = await t.app.inject({ method: "GET", url: "/api/my/w2", headers: session });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ w2s: [] });
    const pdf = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(pdf.statusCode).toBe(404);
  });

  it("401s without a session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/my/w2" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Reminders — annual rows fire tax_filing_due like any other filing
// ---------------------------------------------------------------------------

describe("annual filing reminders", () => {
  it("mails admins on the configured offsets and dedupes", async () => {
    // The W-2/W-3 row (due 2026-02-02) is unfiled; the 940 row is filed and
    // must never remind. Default offsets [14, 7, 0] → fire dates
    // 2026-01-19, 2026-01-26, 2026-02-02.
    const outboxCount = async () =>
      (
        await t.db
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.eventType, EVENT_TYPE.taxFilingDue))
      ).length;

    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-18" })).sent,
    ).toBe(0); // not a fire date
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-19" })).sent,
    ).toBe(1); // offset 14
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-19" })).sent,
    ).toBe(0); // re-tick: never twice
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-26" })).sent,
    ).toBe(1); // offset 7
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-02-02" })).sent,
    ).toBe(1); // offset 0 (due date)

    expect(await outboxCount()).toBe(3);
    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, EVENT_TYPE.taxFilingDue));
    expect(mails[0]?.subject).toContain("W-2/W-3");
    expect(mails[0]?.subject).toContain("2025");
    expect((await annualFilingRow("w2_w3", 2025))?.remindersSent).toEqual([14, 7, 0]);
  });
});

// ---------------------------------------------------------------------------
// W-2 availability notices — once per tax year, employees only, no amounts
// ---------------------------------------------------------------------------

describe("sendW2AvailableNotices", () => {
  it("mails every W-2 employee with an account, exactly once per year", async () => {
    const sent = await sendW2AvailableNotices(
      { db: t.db, config: t.config },
      {
        today: "2026-01-05",
      },
    );
    expect(sent.sent).toBe(2); // the two account-linked employees; contractor excluded

    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, EVENT_TYPE.w2Available));
    expect(mails).toHaveLength(2);
    expect(mails[0]?.subject).toContain("2025");
    expect(mails[0]?.bodyHtml).toContain("w2-available:2025");
    // Content rules: the notice states the year + log-in — never amounts/SSN.
    expect(mails[0]?.bodyHtml).not.toContain("8,000");
    expect(mails[0]?.bodyHtml).not.toContain("123-45-6789");

    // Once per year: the dedupe record lives in app_settings.
    const again = await sendW2AvailableNotices(
      { db: t.db, config: t.config },
      {
        today: "2026-01-06",
      },
    );
    expect(again.sent).toBe(0);
    const settings = await t.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "w2_available_notified_years"));
    expect(settings[0]?.value).toEqual([2025]); // 2026 has runs but is NOT yet available
  });
});
