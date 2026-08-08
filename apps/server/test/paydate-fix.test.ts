/**
 * Pay-date amendment fixer tests (2026-07-29): legacy runs imported before
 * the amendment carry pay_date = last day of the period month; the fixer
 * moves them to the 15th — column, snapshot, and hash — idempotently, and
 * never touches app-created runs.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@payroll/db";
import { auditEvents, company, employees, payrollRuns } from "@payroll/db";
import type { Db } from "../src/db.js";
import { LEGACY_CREATED_BY } from "../src/migrate/migrate.js";
import { fixLegacyPaydates, PAYDATE_FIX_ACTOR } from "../src/migrate/paydate-fix.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { runMigrations } from "./helpers.js";

let pglite: PGlite;
let db: Db;

function snapshotFor(periodStart: string, periodEnd: string, payDate: string): RunSnapshot {
  return {
    inputs: {
      periodAmount: 4000,
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
      company: { legalName: "Example Corp" },
      employee: { legalName: "Ada Lovelace", preferredName: null },
    },
    result: {
      grossPay: 4000,
      federalWithholding: 0,
      socialSecurity: 248,
      medicare: 58,
      stateWithholding: 0,
      totalDeductions: 306,
      netPay: 3694,
      employerSocialSecurity: 248,
      employerMedicare: 58,
      employerFUTA: 24,
      totalEmployerCost: 4330,
      ytdGross: 4000,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.0.0",
  };
}

async function insertRun(opts: {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  createdBy: string;
}): Promise<number> {
  const snapshot = snapshotFor(opts.periodStart, opts.periodEnd, opts.payDate);
  const inserted = await db
    .insert(payrollRuns)
    .values({
      employeeId: 1,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      payDate: opts.payDate,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: opts.createdBy,
    })
    .returning();
  return inserted[0]!.id;
}

beforeEach(async () => {
  pglite = new PGlite("memory://");
  await runMigrations(pglite);
  db = drizzle(pglite, { schema }) as unknown as Db;
  await db.insert(company).values({ legalName: "Example Corp" });
  await db.insert(employees).values({
    companyId: 1,
    employmentType: "w2",
    legalName: "Ada Lovelace",
    hireDate: "2025-01-01",
    status: "active",
  });
});

afterEach(async () => {
  await pglite.close();
});

describe("fixLegacyPaydates", () => {
  it("corrects month-end pay dates to the 15th — column, snapshot, and hash", async () => {
    const runId = await insertRun({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      payDate: "2026-07-31", // the pre-amendment derivation
      createdBy: LEGACY_CREATED_BY,
    });

    const report = await fixLegacyPaydates(db);
    expect(report).toEqual({ scanned: 1, corrected: 1, alreadyCorrect: 0 });

    const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
    expect(run!.payDate).toBe("2026-07-15");
    const snapshot = run!.runSnapshot as RunSnapshot;
    expect(snapshot.inputs.payDate).toBe("2026-07-15");
    // Hash tracks the patched snapshot exactly.
    expect(run!.snapshotHash).toBe(snapshotHash(snapshot));

    // The correction is recorded in the audit trail.
    const audit = await db.select().from(auditEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: PAYDATE_FIX_ACTOR,
      action: "run.paydate_corrected",
      entity: "payroll_run",
      entityId: String(runId),
      before: { payDate: "2026-07-31" },
    });
    expect((audit[0]!.after as { payDate: string }).payDate).toBe("2026-07-15");
  });

  it("is idempotent and never touches app-created runs", async () => {
    const legacyId = await insertRun({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      payDate: "2026-06-30",
      createdBy: LEGACY_CREATED_BY,
    });
    const appRunId = await insertRun({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      payDate: "2026-07-31",
      createdBy: "scheduler",
    });

    const first = await fixLegacyPaydates(db);
    expect(first).toEqual({ scanned: 1, corrected: 1, alreadyCorrect: 0 });
    const second = await fixLegacyPaydates(db);
    expect(second).toEqual({ scanned: 1, corrected: 0, alreadyCorrect: 1 });

    const [appRun] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, appRunId));
    expect(appRun!.payDate).toBe("2026-07-31"); // untouched
    const [legacy] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, legacyId));
    expect(legacy!.payDate).toBe("2026-06-15");
    // Exactly one audit row (the first pass); the idempotent second pass adds none.
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });
});
