/**
 * PAY-26 integration tests — write-time guard for the per-employee annual
 * employer_futa cap (futaWageCap × futaRate for the run's tax year).
 *
 * Two layers, both exercised against real SQL via the PGlite harness:
 *   1. generateDraft (apps/server/src/payroll/runs.ts) rejects a draft whose
 *      issued-YTD + this-run employer_futa would exceed the cap → HTTP 400
 *      with error "futa_cap_exceeded".
 *   2. Migration 0017 trigger payroll_entries_futa_annual_cap rejects ANY
 *      insert (including direct SQL) that would push the employee+year total
 *      over the cap — defense in depth behind the immutable issued runs.
 *
 * Both layers allow a rounding tolerance (half a cent per period — the
 * per-paycheck cent rounding that the 940 worksheet reconciles as
 * roundingDelta; see annual-forms.test.ts's $1,111.11/mo employee, whose 12
 * issued runs sum to $420.02). The guards target material violations like the
 * incident's 10× rate error, not rounding noise.
 *
 * Fixture: $4,000/mo salaries so FUTA crosses the $7,000 wage cap mid-period —
 * at 6.0% net (no SUTA credit) Jan accrues 240.00, Feb 180.00 (partial, base
 * $3,000), Mar 0.00; the annual cap is exactly 420.00. A second year at 0.6%
 * net (full credit) has cap 42.00 (24.00 + 18.00).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  company,
  compensation,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { TAX_CONFIG } from "@payroll/engine";
import { generateDraft, monthlyPeriod, PayrollServiceError } from "../src/payroll/runs.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

let employeeA: number; // full-year, $4,000/mo from 2030-01-01
let employeeB: number; // mid-year hire, $4,000/mo from 2030-06-01
let employeeC: number; // direct-SQL trigger fixture, $4,000/mo from 2030-01-01

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

/** Generate → approve → issue one monthly run; returns the run row. */
async function issueRun(year: number, month: number, employeeId: number) {
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
  return run;
}

/** employer_futa entry amounts for an employee+year, period order. */
async function futaEntries(employeeId: number, year: number): Promise<string[]> {
  const rows = await t.db
    .select({ amount: payrollEntries.amount, periodStart: payrollRuns.periodStart })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollEntries.category, "employer_futa"),
        eq(payrollRuns.status, "issued"),
      ),
    )
    .orderBy(asc(payrollRuns.periodStart));
  return rows.filter((r) => r.periodStart.startsWith(String(year))).map((r) => r.amount);
}

/** Insert a fake ISSUED run + entries directly in SQL (bypasses the app guard). */
async function insertIssuedRun(
  employeeId: number,
  periodStart: string,
  entries: [category: string, amount: string][],
) {
  const mm = periodStart.slice(5, 7);
  const yyyy = periodStart.slice(0, 4);
  const lastDay = new Date(Date.UTC(Number(yyyy), Number(mm), 0)).getUTCDate();
  const rows = await t.db
    .insert(payrollRuns)
    .values({
      employeeId,
      periodStart,
      periodEnd: `${yyyy}-${mm}-${String(lastDay).padStart(2, "0")}`,
      payDate: `${yyyy}-${mm}-15`,
      status: "issued",
      runSnapshot: {},
      createdBy: "test-direct-sql",
    })
    .returning();
  const run = rows[0];
  if (!run) throw new Error("direct run insert failed");
  for (const [category, amount] of entries) {
    await t.db.insert(payrollEntries).values({ runId: run.id, category, amount });
  }
  return run;
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "futa-cap-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const companyId = companyRows[0]?.id ?? 1;
  const hires: [string, string][] = [
    ["Cap Alice", "2030-01-01"],
    ["Cap Bob", "2030-06-01"],
    ["Cap Carol", "2030-01-01"],
  ];
  const ids: number[] = [];
  for (const [legalName, hireDate] of hires) {
    const rows = await t.db
      .insert(employees)
      .values({ companyId, legalName, hireDate })
      .returning();
    const id = rows[0]?.id;
    if (!id) throw new Error("employee insert failed");
    ids.push(id);
    await t.db.insert(compensation).values({
      employeeId: id,
      periodAmount: "4000",
      frequency: "monthly",
      effectiveFrom: hireDate,
      effectiveTo: null,
    });
  }
  [employeeA, employeeB, employeeC] = ids as [number, number, number];

  // 2030: no SUTA credit → 6.0% net, cap $420. 2031: full credit → 0.6%, cap
  // $42. 2032/2033: back to 6.0% for the violation + trigger fixtures.
  await putTaxConfig(2030, 0);
  await putTaxConfig(2031, 0.054);
  await putTaxConfig(2032, 0);
  await putTaxConfig(2033, 0);
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("cap crossing mid-period (partial FUTA month), cap reached exactly", () => {
  it("Jan 240.00 + Feb 180.00 + Mar 0.00 = exactly the 420.00 cap — all allowed", async () => {
    await issueRun(2030, 1, employeeA);
    await issueRun(2030, 2, employeeA); // sum hits 420.00 exactly — ≤ cap passes
    await issueRun(2030, 3, employeeA); // cap reached, accrual 0.00
    expect(await futaEntries(employeeA, 2030)).toEqual(["240.00", "180.00", "0.00"]);
  });

  it("second employee added mid-year accrues independently against the same cap", async () => {
    await issueRun(2030, 6, employeeB);
    await issueRun(2030, 7, employeeB);
    expect(await futaEntries(employeeB, 2030)).toEqual(["240.00", "180.00"]);
  });
});

describe("rate-change year — cap scales with futa_rate", () => {
  it("2031 at 0.6% net → cap 42.00; Jan 24.00 + Feb 18.00 = exactly 42.00", async () => {
    await issueRun(2031, 1, employeeA);
    await issueRun(2031, 2, employeeA);
    expect(await futaEntries(employeeA, 2031)).toEqual(["24.00", "18.00"]);
  });
});

describe("application guard — generateDraft rejects over-cap runs", () => {
  it("issued YTD 420.00 + any further accrual → skipped with futa_cap_exceeded", async () => {
    // Bypass the app layer: an issued Jan-2032 run already AT the 420.00 cap,
    // with gross 4000 so the Feb engine computation still accrues FUTA.
    await insertIssuedRun(employeeA, "2032-01-01", [
      ["gross_pay", "4000.00"],
      ["employer_futa", "420.00"],
    ]);

    // The bulk generate route reports per-employee guard rejections in
    // `skipped` (the established pattern for no_compensation & co).
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2032, month: 2, employeeId: employeeA },
    });
    expect(gen.statusCode, gen.body).toBe(201);
    const body = gen.json() as {
      generated: unknown[];
      skipped: { employeeId: number; reason: string }[];
    };
    expect(body.generated).toEqual([]);
    expect(body.skipped).toEqual([{ employeeId: employeeA, reason: "futa_cap_exceeded" }]);

    // The service error itself carries the full diagnostic (amounts + year).
    const err = await generateDraft(
      { db: t.db, config: t.config },
      { employeeId: employeeA, period: monthlyPeriod(2032, 2, 15), createdBy: "test" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PayrollServiceError);
    expect((err as PayrollServiceError).code).toBe("futa_cap_exceeded");
    expect((err as PayrollServiceError).message).toContain("600.00");
    expect((err as PayrollServiceError).message).toContain("420.00");
    expect((err as PayrollServiceError).message).toContain("2032");

    // The rejected draft left nothing behind (transaction rolled back).
    expect(await futaEntries(employeeA, 2032)).toEqual(["420.00"]);
  });
});

describe("DB trigger — defense in depth behind direct writes", () => {
  it("allows inserts up to the cap, rejects the one that crosses it", async () => {
    const jan = await insertIssuedRun(employeeC, "2033-01-01", [["gross_pay", "4000.00"]]);
    const feb = await insertIssuedRun(employeeC, "2033-02-01", [["gross_pay", "4000.00"]]);

    // 300.00 ≤ 420.00 cap → allowed even though it doesn't match engine math.
    await t.db
      .insert(payrollEntries)
      .values({ runId: jan.id, category: "employer_futa", amount: "300.00" });

    // 300.00 + 300.00 = 600.00 > 420.00 → trigger raises, nothing is written.
    // (Drizzle wraps the PG error; the trigger's message is on the cause.)
    const err = await t.db
      .insert(payrollEntries)
      .values({ runId: feb.id, category: "employer_futa", amount: "300.00" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const chain =
      err instanceof Error ? `${err.message} ${(err.cause as Error)?.message ?? ""}` : String(err);
    expect(chain).toContain("employer_futa annual cap exceeded");

    expect(await futaEntries(employeeC, 2033)).toEqual(["300.00"]);
  });

  it("exact-cap insert is allowed (≤, not <)", async () => {
    const feb = (
      await t.db
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(
          and(eq(payrollRuns.employeeId, employeeC), eq(payrollRuns.periodStart, "2033-02-01")),
        )
    )[0];
    // 300.00 + 120.00 = exactly the 420.00 cap → allowed.
    await t.db
      .insert(payrollEntries)
      .values({ runId: feb?.id ?? -1, category: "employer_futa", amount: "120.00" });
    expect(await futaEntries(employeeC, 2033)).toEqual(["300.00", "120.00"]);
  });
});
