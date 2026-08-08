/**
 * One-off correction for deployments that ran the legacy migration BEFORE the
 * pay-date amendment (2026-07-29): the first import derived pay_date as the
 * LAST DAY of the period month; the owner-confirmed legacy payday is the
 * 15th (same day the app's default pay schedule uses).
 *
 * For every legacy-imported run whose pay_date is not the 15th of its period
 * month: set payroll_runs.pay_date, patch run_snapshot.inputs.payDate (the
 * payslip PDF renders from the snapshot, so the column alone is not enough),
 * recompute snapshot_hash, and record the correction in audit_events.
 *
 * ⚠ The immutability trigger (migration 0001,
 * payroll_runs_enforce_immutability) FORBIDS changing pay_date/run_snapshot
 * on issued runs — correctly so. This is not an amendment of live payroll:
 * it repairs rows that were imported with the wrong derivation before the
 * app ever served them as truth. The trigger is therefore suspended inside
 * THIS transaction only (Postgres DDL is transactional — a failure rolls the
 * suspension back with everything else). App-created runs are never touched;
 * `updatedAt` is left untouched to preserve import provenance.
 * Idempotent: a second run finds nothing stale and writes nothing.
 */

import { eq, sql } from "drizzle-orm";
import { auditEvents, payrollRuns } from "@payroll/db";
import type { Db } from "../db.js";
import { LEGACY_CREATED_BY } from "./migrate.js";
import { snapshotHash, type RunSnapshot } from "../payroll/snapshot.js";

export const PAYDATE_FIX_ACTOR = "cli:fix-legacy-paydates";
const IMMUTABILITY_TRIGGER = "payroll_runs_immutable_once_issued";

export interface PaydateFixReport {
  scanned: number;
  corrected: number;
  alreadyCorrect: number;
}

export async function fixLegacyPaydates(
  db: Db,
  log: (line: string) => void = () => {},
): Promise<PaydateFixReport> {
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.createdBy, LEGACY_CREATED_BY));
  const stale = runs.filter((run) => run.payDate !== `${run.periodStart.slice(0, 7)}-15`);
  const alreadyCorrect = runs.length - stale.length;

  if (stale.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`ALTER TABLE payroll_runs DISABLE TRIGGER ${IMMUTABILITY_TRIGGER}`));
      try {
        for (const run of stale) {
          const expected = `${run.periodStart.slice(0, 7)}-15`;
          const snapshot = run.runSnapshot as RunSnapshot;
          const next: RunSnapshot = {
            ...snapshot,
            inputs: { ...snapshot.inputs, payDate: expected },
          };
          await tx
            .update(payrollRuns)
            .set({ payDate: expected, runSnapshot: next, snapshotHash: snapshotHash(next) })
            .where(eq(payrollRuns.id, run.id));
          await tx.insert(auditEvents).values({
            actorId: PAYDATE_FIX_ACTOR,
            action: "run.paydate_corrected",
            entity: "payroll_run",
            entityId: String(run.id),
            before: { payDate: run.payDate },
            after: {
              payDate: expected,
              reason: "2026-07-29 amendment: owner-confirmed legacy payday is the 15th",
            },
          });
          log(`  corrected ${run.periodStart.slice(0, 7)}: pay_date ${run.payDate} → ${expected}`);
        }
      } finally {
        await tx.execute(
          sql.raw(`ALTER TABLE payroll_runs ENABLE TRIGGER ${IMMUTABILITY_TRIGGER}`),
        );
      }
    });
  }

  log(
    `pay-date fix: ${stale.length} corrected, ${alreadyCorrect} already correct ` +
      `(${runs.length} legacy run(s) scanned)`,
  );
  return { scanned: runs.length, corrected: stale.length, alreadyCorrect };
}
