/**
 * Migration tests (spec 9) — the legacy import is exercised end-to-end against
 * TWO PGlites: a source mimicking `second_brain.accounting` (exact DDL + real
 * seed values + engine-computed synthetic runs) and a target running the real
 * drizzle migrations. No mocks; the SQL under test is the production SQL.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@payroll/db";
import {
  company,
  compensation,
  employees,
  legacyMigrationMap,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxBrackets,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import type { Db } from "../src/db.js";
import {
  LEGACY_ENGINE_VERSION,
  migrateLegacy,
  MigrationValidationError,
  type MigrationReport,
} from "../src/migrate/migrate.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { runMigrations } from "./helpers.js";
import {
  createSourceFixture,
  FIXTURE_RUN_PERIODS,
  LEGACY_COMPENSATION,
  LEGACY_EMPLOYEE,
  LEGACY_W4,
  type SourceFixture,
} from "./migrate-fixture.js";

const RUN_COUNT = FIXTURE_RUN_PERIODS.length; // 19
const ENTRIES_PER_RUN = 9;
const SILENT = () => {};

let fixture: SourceFixture;
let targetPglite: PGlite;
let db: Db;

async function createTarget(): Promise<void> {
  targetPglite = new PGlite("memory://");
  await runMigrations(targetPglite);
  db = drizzle(targetPglite, { schema }) as unknown as Db;
}

beforeEach(async () => {
  fixture = await createSourceFixture();
  await createTarget();
});

afterEach(async () => {
  await fixture.close();
  await targetPglite.close();
});

async function countOf(
  table: "company" | "employees" | "compensation" | "w4" | "taxConfig" | "taxBrackets" | "runs" | "entries" | "map",
): Promise<number> {
  switch (table) {
    case "company":
      return (await db.select().from(company)).length;
    case "employees":
      return (await db.select().from(employees)).length;
    case "compensation":
      return (await db.select().from(compensation)).length;
    case "w4":
      return (await db.select().from(w4Elections)).length;
    case "taxConfig":
      return (await db.select().from(taxConfig)).length;
    case "taxBrackets":
      return (await db.select().from(taxBrackets)).length;
    case "runs":
      return (await db.select().from(payrollRuns)).length;
    case "entries":
      return (await db.select().from(payrollEntries)).length;
    case "map":
      return (await db.select().from(legacyMigrationMap)).length;
  }
}

async function runMigration(opts: { dryRun?: boolean; verbose?: boolean } = {}): Promise<MigrationReport> {
  return migrateLegacy({ source: fixture.source, db }, { dryRun: opts.dryRun, verbose: opts.verbose, log: SILENT });
}

/** Target run rows joined to their source ids via the ledger. */
async function runsByPeriod(): Promise<Map<string, typeof payrollRuns.$inferSelect>> {
  const rows = await db.select().from(payrollRuns);
  return new Map(rows.map((r) => [r.periodStart.slice(0, 7), r]));
}

async function entriesFor(runId: number): Promise<Map<string, string>> {
  const rows = await db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId));
  return new Map(rows.map((e) => [e.category, e.amount]));
}

describe("legacy migration", () => {
  it("dry-run produces the full plan with ZERO writes", async () => {
    const report = await runMigration({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.runsValidated).toBe(RUN_COUNT);
    const byEntity = new Map(report.entities.map((e) => [e.entity, e]));
    expect(byEntity.get("company")).toMatchObject({ sourceRows: 1, inserted: 1, existing: 0 });
    expect(byEntity.get("employee")).toMatchObject({ sourceRows: 1, inserted: 1 });
    expect(byEntity.get("compensation")).toMatchObject({ sourceRows: 2, inserted: 2 });
    expect(byEntity.get("w4_elections")).toMatchObject({ sourceRows: 1, inserted: 1 });
    expect(byEntity.get("tax_config")).toMatchObject({ sourceRows: 2, inserted: 2 });
    expect(byEntity.get("tax_brackets")).toMatchObject({ sourceRows: 14, inserted: 14 });
    expect(byEntity.get("payroll_runs")).toMatchObject({ sourceRows: RUN_COUNT, inserted: RUN_COUNT });
    // NOT-migrated accounting tables are reported as skipped.
    expect(report.skippedTables).toEqual([
      { table: "time_off", rows: 1 },
      { table: "compliance_filings", rows: 1 },
      { table: "deposits", rows: 1 },
    ]);
    expect(report.runsWithStubPath).toBe(1);

    // Zero writes — every target table still empty.
    expect(await countOf("company")).toBe(0);
    expect(await countOf("employees")).toBe(0);
    expect(await countOf("compensation")).toBe(0);
    expect(await countOf("w4")).toBe(0);
    expect(await countOf("taxConfig")).toBe(0);
    expect(await countOf("taxBrackets")).toBe(0);
    expect(await countOf("runs")).toBe(0);
    expect(await countOf("entries")).toBe(0);
    expect(await countOf("map")).toBe(0);
  });

  it("--write migrates everything; counts match; snapshots validate to the cent", async () => {
    await runMigration({ dryRun: false });

    expect(await countOf("company")).toBe(1);
    expect(await countOf("employees")).toBe(1);
    expect(await countOf("compensation")).toBe(2);
    expect(await countOf("w4")).toBe(1);
    expect(await countOf("taxConfig")).toBe(2);
    expect(await countOf("taxBrackets")).toBe(14);
    expect(await countOf("runs")).toBe(RUN_COUNT);
    expect(await countOf("entries")).toBe(RUN_COUNT * ENTRIES_PER_RUN);
    // ledger: 1 company + 1 employee + 2 comp + 1 w4 + 2 tax + 14 brackets + 19 runs
    expect(await countOf("map")).toBe(40);

    // company + employee shape
    const [co] = await db.select().from(company);
    expect(co!.legalName).toBe(LEGACY_EMPLOYEE.entity);
    const [emp] = await db.select().from(employees);
    expect(emp).toMatchObject({
      legalName: LEGACY_EMPLOYEE.fullName,
      employmentType: "w2",
      hireDate: LEGACY_COMPENSATION[0].effectiveFrom, // documented derivation
      status: "active",
      companyId: co!.id,
      userId: null,
    });

    // compensation shape
    const comps = await db.select().from(compensation).orderBy(compensation.effectiveFrom);
    expect(comps.map((c) => [c.periodAmount, c.frequency, c.effectiveFrom, c.effectiveTo])).toEqual([
      ["3500.00", "monthly", "2025-01-01", "2026-03-31"],
      ["3750.00", "monthly", "2026-04-01", null],
    ]);

    // W-4 shape (exempt, effective-dated, renewal preserved, 2020+ fields 0)
    const [w4] = await db.select().from(w4Elections);
    expect(w4).toMatchObject({
      taxYear: LEGACY_W4.taxYear,
      filingStatus: "single",
      federalExempt: true,
      effectiveFrom: LEGACY_W4.effectiveFrom,
      filedDate: LEGACY_W4.filedDate,
      renewalDeadline: LEGACY_W4.renewalDeadline,
      dependentsAmount: "0.00",
      otherIncome: "0.00",
      deductionsAmount: "0.00",
      extraWithholding: "0.00",
    });

    // Every run: issued, issued_at = created_at, pay_date = last day of month,
    // snapshot hash recomputes, result matches entries to the cent.
    const runs = await db.select().from(payrollRuns);
    expect(runs).toHaveLength(RUN_COUNT);
    for (const run of runs) {
      expect(run.status).toBe("issued");
      expect(run.createdBy).toBe("legacy-import");
      expect(run.issuedAt?.getTime()).toBe(run.createdAt?.getTime());
      expect(run.payDate).toBe(run.periodEnd);
      const snapshot = run.runSnapshot as RunSnapshot;
      expect(snapshot.engineVersion).toBe(LEGACY_ENGINE_VERSION);
      expect(run.snapshotHash).toBe(snapshotHash(snapshot));

      const entries = await entriesFor(run.id);
      expect(entries.size).toBe(ENTRIES_PER_RUN);
      const fieldByCategory: Record<string, keyof RunSnapshot["result"]> = {
        gross_pay: "grossPay",
        federal_withholding: "federalWithholding",
        social_security: "socialSecurity",
        medicare: "medicare",
        state_withholding: "stateWithholding",
        net_pay: "netPay",
        employer_social_security: "employerSocialSecurity",
        employer_medicare: "employerMedicare",
        employer_futa: "employerFUTA",
      };
      for (const [category, field] of Object.entries(fieldByCategory)) {
        expect(entries.get(category), `${run.periodStart} ${category}`).toBe(
          (snapshot.result[field] as number).toFixed(2),
        );
      }
    }
  });

  it("golden value: 2025-01 federal withholding is the documented $250.13", async () => {
    await runMigration({ dryRun: false });
    const runs = await runsByPeriod();
    const jan = runs.get("2025-01")!;
    const entries = await entriesFor(jan.id);
    expect(entries.get("federal_withholding")).toBe("250.13");
    expect(entries.get("gross_pay")).toBe("3500.00");
  });

  it("month boundary: Jan–Mar 2026 withheld, Apr+ $0 (W-4 exempt cutover)", async () => {
    await runMigration({ dryRun: false });
    const runs = await runsByPeriod();

    const mar = await entriesFor(runs.get("2026-03")!.id);
    const apr = await entriesFor(runs.get("2026-04")!.id);
    expect(Number(mar.get("federal_withholding"))).toBeGreaterThan(0);
    expect(apr.get("federal_withholding")).toBe("0.00");
    // The raise lands the same month: $3,500 → $3,750.
    expect(mar.get("gross_pay")).toBe("3500.00");
    expect(apr.get("gross_pay")).toBe("3750.00");

    // Snapshot W-4 resolution mirrors the boundary: none before Apr, exempt from Apr.
    const marSnapshot = runs.get("2026-03")!.runSnapshot as RunSnapshot;
    const aprSnapshot = runs.get("2026-04")!.runSnapshot as RunSnapshot;
    expect(marSnapshot.inputs.w4).toBeNull();
    expect(aprSnapshot.inputs.w4?.federalExempt).toBe(true);
    expect(aprSnapshot.inputs.w4?.effectiveFrom).toBe("2026-04-01");
    // And 2025 never had an election.
    const janSnapshot = runs.get("2025-01")!.runSnapshot as RunSnapshot;
    expect(janSnapshot.inputs.w4).toBeNull();
    // SS/Medicare still withheld in exempt months (FICA is not exempt).
    expect(Number(apr.get("social_security"))).toBeGreaterThan(0);
    expect(Number(apr.get("medicare"))).toBeGreaterThan(0);
  });

  it("re-running --write is a no-op (idempotent via legacy_migration_map)", async () => {
    const first = await runMigration({ dryRun: false });
    const second = await runMigration({ dryRun: false });

    expect(second.runsValidated).toBe(RUN_COUNT); // validation always runs
    for (const e of second.entities) {
      expect(e.inserted, e.entity).toBe(0);
      expect(e.existing).toBe(e.sourceRows);
    }
    expect(await countOf("runs")).toBe(RUN_COUNT);
    expect(await countOf("entries")).toBe(RUN_COUNT * ENTRIES_PER_RUN);
    expect(await countOf("map")).toBe(40);
    // Dry-run after a full migration plans nothing new either.
    const third = await runMigration({ dryRun: true });
    expect(third.entities.every((e) => e.inserted === 0)).toBe(true);
    void first;
  });

  it("a stored entry off by $0.01 HALTS the migration and writes nothing", async () => {
    await fixture.close();
    fixture = await createSourceFixture({ corrupt: { year: 2025, month: 6 } });

    const err = await runMigration({ dryRun: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationValidationError);
    const failures = (err as MigrationValidationError).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sourceRunId: fixture.runIds.get("2025-06"),
      year: 2025,
      month: 6,
      category: "federal_withholding",
    });
    expect(Number(failures[0]!.stored) - Number(failures[0]!.recomputed)).toBeCloseTo(0.01, 2);

    // Nothing was written — validation precedes any insert.
    expect(await countOf("runs")).toBe(0);
    expect(await countOf("company")).toBe(0);
    expect(await countOf("map")).toBe(0);

    // Dry-run against the same corrupted source also refuses.
    const dryErr = await runMigration({ dryRun: true }).catch((e: unknown) => e);
    expect(dryErr).toBeInstanceOf(MigrationValidationError);
  });

  it("coexists with `pnpm seed`: seeded tax tables are adopted, not duplicated", async () => {
    await seedDatabase(db as never);
    expect(await countOf("taxConfig")).toBe(2); // 2025 + 2026 from the seed
    expect(await countOf("taxBrackets")).toBe(28); // federal + federal:single

    const report = await runMigration({ dryRun: false });
    const byEntity = new Map(report.entities.map((e) => [e.entity, e]));
    expect(byEntity.get("company")).toMatchObject({ inserted: 0, existing: 1 });
    expect(byEntity.get("tax_config")).toMatchObject({ inserted: 0, existing: 2 });
    expect(byEntity.get("tax_brackets")).toMatchObject({ inserted: 0, existing: 14 });

    expect(await countOf("company")).toBe(1); // not duplicated
    expect(await countOf("taxConfig")).toBe(2);
    expect(await countOf("taxBrackets")).toBe(28); // federal:single untouched
    expect(await countOf("runs")).toBe(RUN_COUNT);
    // The adopted rows are in the ledger, so a re-run is still a clean no-op.
    expect(await countOf("map")).toBe(40);
  });
});
