/**
 * Temporal config resolution (spec payroll-engine "Config resolution is
 * temporal"): every lookup is "row effective on the period", computed inside
 * the run transaction. Edits to salary/tax tables never mutate existing runs.
 *
 * All functions accept a drizzle transaction or db handle (PgTransaction
 * compatible).
 */

import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  compensation,
  payrollEntries,
  payrollRuns,
  taxBrackets,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import type { Db } from "../db.js";
import type { SnapshotBracket, SnapshotTaxConfig, SnapshotW4 } from "./snapshot.js";

/** drizzle transaction or root db — both expose the query API we use. */
export type DbLike = Pick<Db, "select">;

export type CompensationRow = typeof compensation.$inferSelect;
export type W4Row = typeof w4Elections.$inferSelect;

/** Compensation row effective on `asOf` (effective_from <= asOf < effective_to|∞, matching the [) exclusion constraint). */
export async function resolveCompensation(
  db: DbLike,
  employeeId: number,
  asOf: string,
): Promise<CompensationRow | null> {
  const rows = await db
    .select()
    .from(compensation)
    .where(
      and(
        eq(compensation.employeeId, employeeId),
        lte(compensation.effectiveFrom, asOf),
        or(isNull(compensation.effectiveTo), gt(compensation.effectiveTo, asOf)),
      ),
    )
    .orderBy(desc(compensation.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * W-4 election effective on `periodStart` (latest filed row with
 * effective_from <= period_start). An exempt election whose renewal_deadline
 * has passed no longer exempts (IRC §3402(n)).
 */
export async function resolveW4(
  db: DbLike,
  employeeId: number,
  periodStart: string,
): Promise<W4Row | null> {
  const rows = await db
    .select()
    .from(w4Elections)
    .where(and(eq(w4Elections.employeeId, employeeId), lte(w4Elections.effectiveFrom, periodStart)))
    .orderBy(desc(w4Elections.effectiveFrom))
    .limit(1);
  const row = rows[0] ?? null;
  if (row?.federalExempt && row.renewalDeadline && row.renewalDeadline <= periodStart) {
    return { ...row, federalExempt: false };
  }
  return row;
}

/**
 * Tax config + brackets for a year and filing status. Bracket sets are per
 * filing status via jurisdiction = 'federal:<status>' (spec payroll-engine
 * §3), falling back to the base 'federal' jurisdiction; scalar config falls
 * back the same way.
 */
export async function resolveTaxConfig(
  db: DbLike,
  taxYear: number,
  filingStatus: string,
): Promise<{ config: SnapshotTaxConfig; brackets: SnapshotBracket[] } | null> {
  const jurisdictions = [`federal:${filingStatus}`, "federal"];

  let configRow: typeof taxConfig.$inferSelect | undefined;
  for (const j of jurisdictions) {
    const rows = await db
      .select()
      .from(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, j), eq(taxConfig.taxYear, taxYear)))
      .limit(1);
    if (rows[0]) {
      configRow = rows[0];
      break;
    }
  }
  if (!configRow) return null;

  let bracketRows: (typeof taxBrackets.$inferSelect)[] = [];
  for (const j of jurisdictions) {
    bracketRows = await db
      .select()
      .from(taxBrackets)
      .where(and(eq(taxBrackets.jurisdiction, j), eq(taxBrackets.taxYear, taxYear)))
      .orderBy(taxBrackets.ordinal);
    if (bracketRows.length > 0) break;
  }
  if (bracketRows.length === 0) return null;

  return {
    config: {
      jurisdiction: configRow.jurisdiction,
      taxYear: configRow.taxYear,
      standardDeduction: Number(configRow.standardDeduction),
      socialSecurityRate: Number(configRow.socialSecurityRate),
      socialSecurityWageCap: Number(configRow.socialSecurityWageCap),
      medicareRate: Number(configRow.medicareRate),
      medicareAdditionalRate: Number(configRow.medicareAdditionalRate),
      medicareAdditionalThreshold: Number(configRow.medicareAdditionalThreshold),
      stateWithholdingRate: Number(configRow.stateWithholdingRate),
      employerSocialSecurityRate: Number(configRow.employerSocialSecurityRate),
      employerMedicareRate: Number(configRow.employerMedicareRate),
      futaRate: Number(configRow.futaRate),
      futaWageCap: Number(configRow.futaWageCap),
    },
    brackets: bracketRows.map((b) => ({
      min: Number(b.minAmount),
      max: b.maxAmount === null ? null : Number(b.maxAmount),
      rate: Number(b.rate),
    })),
  };
}

/**
 * Prior-YTD gross: SUM of gross_pay payroll_entries from ISSUED runs in the
 * same calendar year before period_start (spec: never wage × period count).
 */
export async function resolvePriorYtdGross(
  db: DbLike,
  employeeId: number,
  periodStart: string,
): Promise<number> {
  const year = periodStart.slice(0, 4);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)` })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollRuns.status, "issued"),
        eq(payrollEntries.category, "gross_pay"),
        gte(payrollRuns.periodStart, `${year}-01-01`),
        lt(payrollRuns.periodStart, periodStart),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export function toSnapshotW4(row: W4Row): SnapshotW4 {
  return {
    filingStatus: row.filingStatus as SnapshotW4["filingStatus"],
    federalExempt: row.federalExempt,
    multipleJobs: row.multipleJobs,
    dependentsAmount: Number(row.dependentsAmount),
    otherIncome: Number(row.otherIncome),
    deductionsAmount: Number(row.deductionsAmount),
    extraWithholding: Number(row.extraWithholding),
    effectiveFrom: row.effectiveFrom,
    filedDate: row.filedDate,
  };
}
