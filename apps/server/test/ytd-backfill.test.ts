/**
 * YTD backfill tests (template 1.1.0, 2026-07-30): legacy runs imported
 * before 1.1.0 have no snapshot.ytd; the backfill derives it from each run's
 * own stored entries (chronological accumulation, stored-is-truth — the
 * 2026-03 deviation run counts at its ISSUED amounts), bumps templateVersion,
 * re-hashes, audits — idempotently, and never touches app-created runs.
 */

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@payroll/db";
import { auditEvents, company, employees, payrollEntries, payrollRuns } from "@payroll/db";
import type { Db } from "../src/db.js";
import { LEGACY_CREATED_BY } from "../src/migrate/migrate.js";
import { backfillLegacyYtd, YTD_BACKFILL_ACTOR } from "../src/migrate/ytd-backfill.js";
import { type RunSnapshot, snapshotHash } from "../src/payroll/snapshot.js";
import { runMigrations } from "./helpers.js";

let pglite: PGlite;
let db: Db;

/** Minimal pre-1.1.0 snapshot — deliberately NO ytd block. */
function legacySnapshot(periodStart: string, periodEnd: string, payDate: string): RunSnapshot {
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
    templateVersion: "1.0.0",
  };
}

async function insertRun(opts: {
  month: string; // "2026-01"
  federal: number;
  net: number;
  createdBy: string;
}): Promise<number> {
  const snapshot = legacySnapshot(`${opts.month}-01`, `${opts.month}-28`, `${opts.month}-15`);
  const inserted = await db
    .insert(payrollRuns)
    .values({
      employeeId: 1,
      periodStart: `${opts.month}-01`,
      periodEnd: `${opts.month}-28`,
      payDate: `${opts.month}-15`,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: opts.createdBy,
    })
    .returning();
  const runId = inserted[0]!.id;
  await db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: "3500.00" },
    { runId, category: "federal_withholding", amount: opts.federal.toFixed(2) },
    { runId, category: "social_security", amount: "217.00" },
    { runId, category: "medicare", amount: "50.75" },
    { runId, category: "state_withholding", amount: "0.00" },
    { runId, category: "net_pay", amount: opts.net.toFixed(2) },
    { runId, category: "employer_social_security", amount: "217.00" },
    { runId, category: "employer_medicare", amount: "50.75" },
    { runId, category: "employer_futa", amount: "21.00" },
  ]);
  return runId;
}

beforeEach(async () => {
  pglite = new PGlite("memory://");
  await runMigrations(pglite);
  db = drizzle(pglite, { schema }) as unknown as Db;
  await db.insert(company).values({ legalName: "SOULT IO LTD" });
  await db.insert(employees).values({
    companyId: 1,
    employmentType: "w2",
    legalName: "Neilson Soult",
    hireDate: "2025-01-01",
    status: "active",
  });
});

afterEach(async () => {
  await pglite.close();
});

describe("backfillLegacyYtd", () => {
  it("accumulates YTD from stored entries — deviation run counts at issued amounts", async () => {
    // 2026-03 is the legacy true-up month: stored federal 472.73 ≠ engine 238.33.
    await insertRun({
      month: "2026-01",
      federal: 250.13,
      net: 2982.12,
      createdBy: LEGACY_CREATED_BY,
    });
    await insertRun({
      month: "2026-02",
      federal: 250.13,
      net: 2982.12,
      createdBy: LEGACY_CREATED_BY,
    });
    const marchId = await insertRun({
      month: "2026-03",
      federal: 472.73,
      net: 2759.52,
      createdBy: LEGACY_CREATED_BY,
    });

    const report = await backfillLegacyYtd(db);
    expect(report).toEqual({ scanned: 3, backfilled: 3, alreadyCurrent: 0 });

    const [march] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, marchId));
    const snapshot = march!.runSnapshot as RunSnapshot;
    expect(snapshot.ytd).toEqual({
      gross: 10500,
      federalWithholding: 972.99, // 250.13 + 250.13 + 472.73 (issued true-up)
      socialSecurity: 651,
      medicare: 152.25,
      stateWithholding: 0,
      totalDeductions: 1776.24, // 10500 − 8723.76
      netPay: 8723.76,
    });
    expect(snapshot.templateVersion).toBe("1.1.0");
    expect(march!.snapshotHash).toBe(snapshotHash(snapshot));

    const audit = await db.select().from(auditEvents);
    expect(audit).toHaveLength(3);
    expect(audit[2]).toMatchObject({
      actorId: YTD_BACKFILL_ACTOR,
      action: "run.ytd_backfilled",
      entity: "payroll_run",
      entityId: String(marchId),
      before: { ytd: null },
    });
  });

  it("is idempotent and never touches app-created runs", async () => {
    const legacyId = await insertRun({
      month: "2026-01",
      federal: 250.13,
      net: 2982.12,
      createdBy: LEGACY_CREATED_BY,
    });
    const appRunId = await insertRun({
      month: "2026-02",
      federal: 250.13,
      net: 2982.12,
      createdBy: "scheduler",
    });

    const first = await backfillLegacyYtd(db);
    expect(first).toEqual({ scanned: 1, backfilled: 1, alreadyCurrent: 0 });
    const second = await backfillLegacyYtd(db);
    expect(second).toEqual({ scanned: 1, backfilled: 0, alreadyCurrent: 1 });

    const [appRun] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, appRunId));
    expect((appRun!.runSnapshot as RunSnapshot).ytd).toBeUndefined(); // untouched
    const [legacy] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, legacyId));
    expect((legacy!.runSnapshot as RunSnapshot).ytd?.gross).toBe(3500);
    // Exactly one audit row (the first pass); the idempotent second pass adds none.
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });
});
