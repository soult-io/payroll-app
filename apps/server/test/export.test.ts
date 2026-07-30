/**
 * Export API tests (D10 activation, Accountant agent request 2026-07-30):
 * service-token auth (401/503), issued-only figures to the cent with all 9
 * categories, company header with decrypted EIN, pay_date range filtering,
 * byte-determinism, CSV format, no PII leakage, and the audit trail.
 * Real SQL via the PGlite harness; requests via app.inject.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, company, employees, payrollEntries, payrollRuns } from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import { EXPORT_ACTOR } from "../src/routes/export.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";

const TOKEN = "test-export-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let t: TestContext;

function snapshotFor(periodStart: string, periodEnd: string, payDate: string): RunSnapshot {
  return {
    inputs: {
      periodAmount: 3500,
      frequency: "monthly",
      periodsPerYear: 12,
      w4: null,
      taxConfig: {
        jurisdiction: "federal",
        taxYear: 2026,
        standardDeduction: 16100,
        socialSecurityRate: 0.062,
        socialSecurityWageCap: 184500,
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
      periodStart,
      periodEnd,
      payDate,
      company: { legalName: "SOULT IO LTD" },
      employee: { legalName: "Neilson Soult", preferredName: null },
    },
    result: {
      grossPay: 3500,
      federalWithholding: 250.13,
      socialSecurity: 217,
      medicare: 50.75,
      stateWithholding: 0,
      totalDeductions: 517.88,
      netPay: 2982.12,
      employerSocialSecurity: 217,
      employerMedicare: 50.75,
      employerFUTA: 21,
      totalEmployerCost: 3788.75,
      ytdGross: 3500,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.1.0",
  };
}

async function insertRun(opts: {
  month: string;
  status: "issued" | "awaiting_approval" | "void";
}): Promise<number> {
  const periodStart = `${opts.month}-01`;
  const periodEnd = `${opts.month}-28`;
  const payDate = `${opts.month}-15`;
  const snapshot = snapshotFor(periodStart, periodEnd, payDate);
  const inserted = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: 1,
      periodStart,
      periodEnd,
      payDate,
      status: opts.status,
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: "legacy-import",
    })
    .returning();
  const runId = inserted[0]!.id;
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: "3500.00" },
    { runId, category: "federal_withholding", amount: "250.13" },
    { runId, category: "social_security", amount: "217.00" },
    { runId, category: "medicare", amount: "50.75" },
    { runId, category: "state_withholding", amount: "0.00" },
    { runId, category: "net_pay", amount: "2982.12" },
    { runId, category: "employer_social_security", amount: "217.00" },
    { runId, category: "employer_medicare", amount: "50.75" },
    { runId, category: "employer_futa", amount: "21.00" },
  ]);
  return runId;
}

beforeAll(async () => {
  t = await createTestApp({ exportToken: TOKEN });
  await t.db.insert(company).values({
    legalName: "SOULT IO LTD",
    ein: encryptField("12-3456789", t.config.encryptionKey),
  });
  await t.db.insert(employees).values({
    companyId: 1,
    employmentType: "w2",
    legalName: "Neilson Soult",
    hireDate: "2025-01-01",
    status: "active",
    // PII that must NEVER appear in the export payload.
    taxId: encryptField("123-45-6789", t.config.encryptionKey),
  });
  await insertRun({ month: "2026-01", status: "issued" });
  await insertRun({ month: "2026-02", status: "issued" });
  await insertRun({ month: "2026-03", status: "awaiting_approval" }); // excluded
  await insertRun({ month: "2026-04", status: "void" }); // excluded
});

afterAll(async () => {
  await t.close();
});

describe("export API auth", () => {
  it("401 without a token, 401 with a wrong token", async () => {
    const noToken = await t.app.inject({ method: "GET", url: "/api/export/payroll-runs" });
    expect(noToken.statusCode).toBe(401);
    const wrong = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("503 when no export-token is configured (explicit disable)", async () => {
    const unconfigured = await createTestApp(); // no exportToken override
    try {
      const res = await unconfigured.app.inject({
        method: "GET",
        url: "/api/export/payroll-runs",
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("export_disabled");
    } finally {
      await unconfigured.close();
    }
  });
});

describe("export API payload", () => {
  it("returns issued runs only, all 9 categories to the cent, decrypted EIN, no PII", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.company).toEqual({ legalName: "SOULT IO LTD", ein: "12-3456789" });
    expect(body.status).toBe("issued");
    expect(body.runs).toHaveLength(2); // draft + void excluded

    const jan = body.runs[0];
    expect(jan).toMatchObject({
      employeeId: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-28",
      payDate: "2026-01-15",
      status: "issued",
    });
    expect(jan.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(jan.entries).toEqual({
      gross_pay: "3500.00",
      federal_withholding: "250.13",
      social_security: "217.00",
      medicare: "50.75",
      state_withholding: "0.00",
      net_pay: "2982.12",
      employer_social_security: "217.00",
      employer_medicare: "50.75",
      employer_futa: "21.00",
    });

    // No surplus PII anywhere in the payload.
    const raw = res.body;
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("taxId");
    expect(raw).not.toContain("tax_id");
    expect(raw).not.toContain("bank");
  });

  it("range filter keys on pay_date, inclusive both ends", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs?from=2026-02-01&to=2026-02-28",
      headers: AUTH,
    });
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].payDate).toBe("2026-02-15");
    expect(body.range).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("is byte-deterministic across identical calls", async () => {
    const url = "/api/export/payroll-runs?from=2026-01-01&to=2026-12-31";
    const a = await t.app.inject({ method: "GET", url, headers: AUTH });
    const b = await t.app.inject({ method: "GET", url, headers: AUTH });
    expect(a.body).toBe(b.body);
  });

  it("csv format: header + one row per issued run, text/csv", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs?format=csv",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe(
      "employee_id,period_start,period_end,pay_date,status,snapshot_hash," +
        "gross_pay,federal_withholding,social_security,medicare,state_withholding," +
        "net_pay,employer_social_security,employer_medicare,employer_futa",
    );
    expect(lines).toHaveLength(3); // header + 2 issued runs
    expect(lines[1]).toContain("2026-01-15,issued,");
    expect(lines[1]).toContain("3500.00,250.13,217.00,50.75,0.00,2982.12,217.00,50.75,21.00");
  });

  it("rejects non-issued status, bad dates, inverted ranges, bad formats", async () => {
    for (const url of [
      "/api/export/payroll-runs?status=draft",
      "/api/export/payroll-runs?from=2026-1-1",
      "/api/export/payroll-runs?from=2026-12-31&to=2026-01-01",
      "/api/export/payroll-runs?format=xlsx",
    ]) {
      const res = await t.app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("every successful call is audited (actor, action, run count)", async () => {
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, EXPORT_ACTOR));
    expect(rows.length).toBeGreaterThanOrEqual(4); // the calls above
    const csvCall = rows.find((r) => (r.after as { format: string }).format === "csv");
    expect(csvCall).toMatchObject({ action: "export.payroll_runs", entity: "export" });
    expect((csvCall!.after as { runCount: number }).runCount).toBe(2);
  });
});
