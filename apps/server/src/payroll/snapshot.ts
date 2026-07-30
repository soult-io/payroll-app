/**
 * run_snapshot contract (spec payroll-engine + documents): the frozen
 * inputs+outputs of a payroll run. Payslip PDFs render from THIS, never from
 * live config. `snapshotHash` = SHA-256 of the canonical JSON so any drift
 * would be detectable.
 */

import { createHash } from "node:crypto";
import type { PayrollResult } from "@payroll/engine";

export const SNAPSHOT_TEMPLATE_VERSION = "1.1.0";

/**
 * Year-to-date accumulations THROUGH this run (inclusive), employee-side.
 * Frozen at issuance so the payslip's YTD block renders from the snapshot
 * alone. Added in template 1.1.0 — optional so pre-1.1.0 snapshots (the
 * initial legacy import) still typecheck; the backfill CLI patches them.
 */
export interface RunSnapshotYtd {
  gross: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
}

export interface SnapshotW4 {
  filingStatus: "single" | "married_joint" | "married_separate" | "head_of_household";
  federalExempt: boolean;
  multipleJobs: boolean;
  dependentsAmount: number;
  otherIncome: number;
  deductionsAmount: number;
  extraWithholding: number;
  effectiveFrom: string;
  filedDate: string;
}

export interface SnapshotTaxConfig {
  jurisdiction: string;
  taxYear: number;
  standardDeduction: number;
  socialSecurityRate: number;
  socialSecurityWageCap: number;
  medicareRate: number;
  medicareAdditionalRate: number;
  medicareAdditionalThreshold: number;
  stateWithholdingRate: number;
  employerSocialSecurityRate: number;
  employerMedicareRate: number;
  futaRate: number;
  futaWageCap: number;
}

export interface SnapshotBracket {
  min: number;
  /** null = open top bracket. */
  max: number | null;
  rate: number;
}

export interface RunSnapshot {
  inputs: {
    periodAmount: number;
    frequency: "weekly" | "biweekly" | "semimonthly" | "monthly";
    periodsPerYear: number;
    w4: SnapshotW4 | null;
    taxConfig: SnapshotTaxConfig;
    /** Bracket set actually applied (filing-status resolved). */
    brackets: SnapshotBracket[];
    priorYtdGross: number;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    /** Display fields copied in at issuance so re-renders never drift (D5). */
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
  };
  result: PayrollResult;
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (template ≥1.1.0). */
  ytd?: RunSnapshotYtd;
  /**
   * Migration-only (legacy import): categories where the ISSUED amount
   * deliberately differs from the recomputed engine result, with the reason.
   * Absent on app-generated runs. See apps/server/src/migrate/migrate.ts
   * STORED_AMOUNT_OVERRIDES.
   */
  legacyDeviations?: {
    category: string;
    stored: string;
    recomputed: string;
    reason: string;
  }[];
  /** Migration-only annotation (e.g. prior-year tax tables applied). */
  legacyNotes?: string[];
}

/** Canonical JSON: object keys sorted recursively, so hashing is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function snapshotHash(snapshot: RunSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}
