/**
 * Annual forms (PAY-11) — Form 940 (FUTA) worksheet + W-2/W-3 generation and
 * filing tracking, reusing the tax_filings table from PAY-10 (form_type
 * '940' / 'w2_w3', quarter 0 = annual; the schema's check constraint already
 * allows them, so no migration is needed). Record-only, same doctrine as the
 * 941: the app computes and tracks; the admin e-files (IRS e-file for 940,
 * SSA Business Services Online for W-2/W-3) and marks the filing here.
 *
 * Determinism: every figure derives from frozen issued-run payroll_entries —
 * never live config (wage caps/rates come from the year's tax_config row,
 * the same source the runs were computed with). employer_futa entries are
 * the paid-liability truth; the form-derived FUTA tax (wages × 0.6%) is
 * reconciled against them to the cent via a documented rounding delta.
 *
 * W-2/W-3 PDFs render on demand (packages/documents) and are never stored.
 * PII (employee SSN/address, company EIN) is decrypted server-side at render
 * time ONLY — JSON endpoints never carry it. W-2s for a tax year become
 * available on January 1 of the following year (w2AvailableOn gate).
 */

import { and, eq, sql } from "drizzle-orm";
import {
  appSettings,
  company,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import type { FormAddress, W2Input, W3Input } from "@payroll/documents";
import {
  EVENT_TYPE,
  w2Available as tplW2Available,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { decryptField } from "../crypto/field-encryption.js";
import {
  type Deps,
  FilingServiceError,
  type TaxFilingRow,
  toMoney,
  todayIso,
  worksheetHash,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Pure date math
// ---------------------------------------------------------------------------

/** Annual-form due date: Jan 31 of the following year, weekend-rolled. */
export function annualDueDate(year: number): string {
  const d = new Date(Date.UTC(year + 1, 1, 0)); // Jan 31 of year + 1
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** W-2s for `year` unlock on January 1 of the following year. */
export function w2AvailableOn(year: number): string {
  return `${year + 1}-01-01`;
}

export function isW2Available(year: number, today: string = todayIso()): boolean {
  return today >= w2AvailableOn(year);
}

/** The year's federal caps/rates — the same source the runs computed with. */
async function federalCaps(
  db: Db,
  year: number,
): Promise<{ ssWageCap: number; futaRate: number; futaWageCap: number }> {
  const rows = await db
    .select()
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, year)))
    .limit(1);
  const row = rows[0];
  // Fallback = engine defaults; in practice a year with issued runs always
  // has a tax_config row (generation requires it).
  return {
    ssWageCap: Number(row?.socialSecurityWageCap ?? 176_100),
    futaRate: Number(row?.futaRate ?? 0.006),
    futaWageCap: Number(row?.futaWageCap ?? 7_000),
  };
}

/** Per-employee sums of the given entry categories, issued runs in the year, W-2 employees only. */
async function perEmployeeSums(db: Db, year: number): Promise<Map<number, Record<string, number>>> {
  const rows = await db
    .select({
      employeeId: payrollRuns.employeeId,
      category: payrollEntries.category,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(payrollRuns.employeeId, payrollEntries.category);
  const byEmployee = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const entry = byEmployee.get(row.employeeId) ?? {};
    entry[row.category] = Number(row.total);
    byEmployee.set(row.employeeId, entry);
  }
  return byEmployee;
}

// ---------------------------------------------------------------------------
// Form 940 (FUTA) worksheet
// ---------------------------------------------------------------------------

export interface Worksheet940 {
  form: "940";
  year: number;
  /** Line 3 — total payments to all employees (gross). */
  line3TotalPayments: string;
  /** Line 7 — total taxable FUTA wages (first $7,000 per employee). */
  line7FutaTaxableWages: string;
  /** Line 8 — FUTA tax before adjustments (line 7 × rate; full state credit). */
  line8FutaTax: string;
  /** Line 12 — total FUTA tax after adjustments (no credit reduction). */
  line12TotalFutaTax: string;
  /** Sum of frozen employer_futa entries — the accrued-liability truth. */
  futaTaxPerFrozenEntries: string;
  /** Cent-level rounding delta: frozen entries minus line 12. */
  roundingDelta: string;
  /**
   * Quarterly deposit rule ($500 threshold): the first quarter whose
   * CUMULATIVE FUTA liability exceeds $500, or null when the annual total
   * stays at or under $500 (then it is paid with the return).
   */
  depositThresholdCrossedQuarter: number | null;
  /** Deposit due date — last day of the month after the crossing quarter. */
  depositDueBy: string | null;
  /** Balance due with the return (no FUTA deposits are tracked in-app). */
  balanceDue: string;
}

/**
 * Compute the annual 940 worksheet from frozen issued-run entries. FUTA
 * taxable wages follow the statutory per-employee $7,000 cap; the resulting
 * tax is reconciled to the cent against the sum of frozen employer_futa
 * entries (per-paycheck rounding delta documented, same doctrine as the
 * 941's line 7). Full state credit assumed — the company state is not a
 * credit-reduction state.
 */
export async function compute940Worksheet(db: Db, year: number): Promise<Worksheet940> {
  const caps = await federalCaps(db, year);
  const byEmployee = await perEmployeeSums(db, year);

  const line3 = round2([...byEmployee.values()].reduce((acc, e) => acc + (e.gross_pay ?? 0), 0));
  const line7 = round2(
    [...byEmployee.values()].reduce(
      (acc, e) => acc + Math.min(e.gross_pay ?? 0, caps.futaWageCap),
      0,
    ),
  );
  const line8 = round2(line7 * caps.futaRate);
  const line12 = line8; // full state credit, no credit reduction

  // Frozen-entry truth + the quarterly $500 deposit-liability check: sum the
  // employer_futa entries by pay quarter (entries are the validated truth,
  // same doctrine as the 941 worksheet and the export API). W-2 employees
  // only, matching perEmployeeSums — contractors can never hold payroll runs
  // (runs.ts hard-asserts), but the join keeps this module self-consistent.
  const futaRows = await db
    .select({
      quarter: sql<number>`extract(quarter from ${payrollRuns.payDate})::int`,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, "employer_futa"),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(sql`extract(quarter from ${payrollRuns.payDate})`);
  const futaPerQuarter = [1, 2, 3, 4].map((q) =>
    round2(Number(futaRows.find((r) => r.quarter === q)?.total ?? "0")),
  );
  const futaEntries = round2(futaPerQuarter.reduce((acc, n) => acc + n, 0));

  let crossed: number | null = null;
  let cumulative = 0;
  for (let q = 1; q <= 4; q++) {
    cumulative = round2(cumulative + (futaPerQuarter[q - 1] ?? 0));
    if (cumulative > 500 && crossed === null) crossed = q;
  }
  // Deposit due the last day of the month following the crossing quarter.
  const depositDueBy =
    crossed === null
      ? null
      : new Date(Date.UTC(year, crossed * 3 + 1, 0)).toISOString().slice(0, 10);

  return {
    form: "940",
    year,
    line3TotalPayments: toMoney(line3),
    line7FutaTaxableWages: toMoney(line7),
    line8FutaTax: toMoney(line8),
    line12TotalFutaTax: toMoney(line12),
    futaTaxPerFrozenEntries: toMoney(futaEntries),
    roundingDelta: toMoney(round2(futaEntries - line12)),
    depositThresholdCrossedQuarter: crossed,
    depositDueBy,
    balanceDue: toMoney(futaEntries),
  };
}

// ---------------------------------------------------------------------------
// W-2 figures (per employee) + W-3 aggregate worksheet
// ---------------------------------------------------------------------------

/** One employee's annual W-2 box figures — NO PII (PII joins at PDF render). */
export interface W2Figures {
  employeeId: number;
  legalName: string;
  box1Wages: number;
  box2FederalWithheld: number;
  box3SsWages: number;
  box4SsTax: number;
  box5MedicareWages: number;
  box6MedicareTax: number;
}

/**
 * Annual W-2 figures per W-2 employee from frozen issued-run entries.
 * Contractors never appear (employment_type = 'w2' only). Box 3 applies the
 * year's Social Security wage cap; box 5 is uncapped (= box 1).
 */
export async function w2FiguresForYear(db: Db, year: number): Promise<W2Figures[]> {
  const caps = await federalCaps(db, year);
  const byEmployee = await perEmployeeSums(db, year);
  const employeeIds = [...byEmployee.keys()];
  if (employeeIds.length === 0) return [];
  const rows = await db
    .select({ id: employees.id, legalName: employees.legalName })
    .from(employees)
    .where(
      sql`${employees.id} IN (${sql.join(
        employeeIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const names = new Map(rows.map((r) => [r.id, r.legalName]));

  const figures: W2Figures[] = [];
  for (const [employeeId, sums] of byEmployee) {
    const box1 = round2(sums.gross_pay ?? 0);
    figures.push({
      employeeId,
      legalName: names.get(employeeId) ?? `#${employeeId}`,
      box1Wages: box1,
      box2FederalWithheld: round2(sums.federal_withholding ?? 0),
      box3SsWages: round2(Math.min(box1, caps.ssWageCap)),
      box4SsTax: round2(sums.social_security ?? 0),
      box5MedicareWages: box1,
      box6MedicareTax: round2(sums.medicare ?? 0),
    });
  }
  // Deterministic code-point sort (localeCompare is host-dependent).
  return figures.sort((a, b) =>
    a.legalName < b.legalName ? -1 : a.legalName > b.legalName ? 1 : 0,
  );
}

export interface WorksheetW3 {
  form: "w2_w3";
  year: number;
  /** Number of W-2 statements summarized. */
  employeeCount: number;
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

/** W-3 transmittal worksheet — the box-by-box aggregate across all W-2s. */
export async function computeW3Worksheet(db: Db, year: number): Promise<WorksheetW3> {
  const figures = await w2FiguresForYear(db, year);
  const sum = (pick: (f: W2Figures) => number) =>
    toMoney(round2(figures.reduce((acc, f) => acc + pick(f), 0)));
  return {
    form: "w2_w3",
    year,
    employeeCount: figures.length,
    box1Wages: sum((f) => f.box1Wages),
    box2FederalWithheld: sum((f) => f.box2FederalWithheld),
    box3SsWages: sum((f) => f.box3SsWages),
    box4SsTax: sum((f) => f.box4SsTax),
    box5MedicareWages: sum((f) => f.box5MedicareWages),
    box6MedicareTax: sum((f) => f.box6MedicareTax),
  };
}

// ---------------------------------------------------------------------------
// Refresh + sync (daily tick, alongside the quarterly 941 sync)
// ---------------------------------------------------------------------------

/**
 * Recompute and persist the worksheet for an UNFILED annual filing. Returns
 * true when the stored worksheet changed. Filed rows are frozen forever (the
 * caller checks status, same as the 941 path).
 */
export async function refreshAnnualWorksheet(db: Db, filing: TaxFilingRow): Promise<boolean> {
  const worksheet =
    filing.formType === "940"
      ? await compute940Worksheet(db, filing.year)
      : await computeW3Worksheet(db, filing.year);
  const hash = worksheetHash(worksheet);
  if (hash === filing.worksheetHash) return false;
  await db
    .update(taxFilings)
    .set({ worksheet, worksheetHash: hash, updatedAt: new Date() })
    .where(eq(taxFilings.id, filing.id));
  return true;
}

export interface AnnualSyncResult {
  created: number;
  refreshed: number;
}

/** Create (when missing) + refresh one annual filing row; filed rows freeze. */
async function upsertAnnualFiling(
  db: Db,
  formType: "940" | "w2_w3",
  year: number,
): Promise<AnnualSyncResult> {
  const existing = await db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, formType), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    )
    .limit(1);
  let row = existing[0];
  let created = 0;
  if (!row) {
    const inserted = await db
      .insert(taxFilings)
      .values({
        formType,
        year,
        quarter: 0,
        dueDate: annualDueDate(year),
        status: "ready",
        createdBy: "scheduler",
      })
      .returning();
    row = inserted[0];
    if (!row) throw new Error("tax_filings insert returned no row");
    created = 1;
  }
  const refreshed = row.status !== "filed" && (await refreshAnnualWorksheet(db, row)) ? 1 : 0;
  return { created, refreshed };
}

/**
 * Upsert 940 + W-2/W-3 tax_filings rows for every ENDED calendar year with
 * issued payroll (quarter 0, due Jan 31 of the following year), then refresh
 * unfiled worksheets. Idempotent: the (form_type, year, quarter) unique
 * constraint is the belt.
 */
export async function syncAnnualFilings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<AnnualSyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();
  const years = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const result: AnnualSyncResult = { created: 0, refreshed: 0 };
  for (const { year } of years) {
    if (`${year}-12-31` >= today) continue; // year not ended yet
    for (const formType of ["940", "w2_w3"] as const) {
      const r = await upsertAnnualFiling(db, formType, year);
      result.created += r.created;
      result.refreshed += r.refreshed;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PDF input assembly (PII decrypted HERE, at render time only)
// ---------------------------------------------------------------------------

function asAddress(value: unknown): FormAddress | null {
  if (value === null || typeof value !== "object") return null;
  const a = value as Partial<FormAddress>;
  if (!a.line1 || !a.city || !a.state || !a.zip || !a.country) return null;
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country,
  };
}

/** 9 decrypted digits → "123-45-6789" (anything else passes through). */
function formatSsn(plain: string): string {
  return /^(\d{3})(\d{2})(\d{4})$/.exec(plain)?.slice(1).join("-") ?? plain;
}

async function employerBlock(
  db: Db,
  config: AppConfig,
): Promise<{ legalName: string; ein: string | null; address: FormAddress | null }> {
  const rows = await db.select().from(company).limit(1);
  const row = rows[0];
  return {
    legalName: row?.legalName ?? "Unknown",
    ein: row?.ein ? decryptField(row.ein, config.encryptionKey) : null,
    address: asAddress(row?.address),
  };
}

/**
 * Assemble the full W-2 PDF input for one employee/year — figures from frozen
 * entries, PII decrypted at this point only. Throws invalid_transition before
 * the January availability gate; not_found when the employee has no W-2 for
 * the year (no issued runs, or a contractor).
 */
export async function w2InputFor(
  deps: Deps,
  employeeId: number,
  year: number,
  opts: { today?: string } = {},
): Promise<W2Input> {
  const { db, config } = deps;
  if (!isW2Available(year, opts.today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-2 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  const figures = (await w2FiguresForYear(db, year)).find((f) => f.employeeId === employeeId);
  if (!figures) {
    throw new FilingServiceError("not_found", `no W-2 for employee ${employeeId} in ${year}`);
  }
  const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const employee = rows[0];
  if (!employee) throw new FilingServiceError("not_found", `employee ${employeeId} not found`);

  return {
    taxYear: year,
    employer: await employerBlock(db, config),
    employee: {
      legalName: employee.legalName,
      ssn: employee.taxId ? formatSsn(decryptField(employee.taxId, config.encryptionKey)) : null,
      address: asAddress(employee.address),
    },
    box1Wages: figures.box1Wages,
    box2FederalWithheld: figures.box2FederalWithheld,
    box3SsWages: figures.box3SsWages,
    box4SsTax: figures.box4SsTax,
    box5MedicareWages: figures.box5MedicareWages,
    box6MedicareTax: figures.box6MedicareTax,
  };
}

/** Assemble the W-3 transmittal PDF input (admin-only; company PII only). */
export async function w3InputFor(
  deps: Deps,
  year: number,
  opts: { today?: string } = {},
): Promise<W3Input> {
  const { db, config } = deps;
  if (!isW2Available(year, opts.today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-3 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  const w3 = await computeW3Worksheet(db, year);
  if (w3.employeeCount === 0) {
    throw new FilingServiceError("not_found", `no W-2s for ${year}`);
  }
  return {
    taxYear: year,
    employer: await employerBlock(db, config),
    employeeCount: w3.employeeCount,
    box1Wages: Number(w3.box1Wages),
    box2FederalWithheld: Number(w3.box2FederalWithheld),
    box3SsWages: Number(w3.box3SsWages),
    box4SsTax: Number(w3.box4SsTax),
    box5MedicareWages: Number(w3.box5MedicareWages),
    box6MedicareTax: Number(w3.box6MedicareTax),
  };
}

// ---------------------------------------------------------------------------
// Employee self-service queries
// ---------------------------------------------------------------------------

/**
 * W-2 years available to this user RIGHT NOW: their own issued runs, gated
 * to January of the following year, newest first.
 */
export async function listMyW2Years(
  db: Db,
  userId: string,
  today: string = todayIso(),
): Promise<number[]> {
  const employeeRows = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, userId), eq(employees.employmentType, "w2")))
    .limit(1);
  const employee = employeeRows[0];
  if (!employee) return [];
  const rows = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.employeeId, employee.id), eq(payrollRuns.status, "issued")));
  return rows
    .map((r) => r.year)
    .filter((year) => isW2Available(year, today))
    .sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// W-2 availability notices (employee email, once per tax year)
// ---------------------------------------------------------------------------

const W2_NOTIFIED_YEARS_KEY = "w2_available_notified_years";

async function notifiedYears(db: Db): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, W2_NOTIFIED_YEARS_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : [];
}

/** W-2 employees (with a user account) who have issued runs in the year. */
async function w2RecipientsForYear(db: Db, year: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: employees.userId })
    .from(payrollRuns)
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
        sql`${employees.userId} IS NOT NULL`,
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => id !== null);
}

/**
 * Mail every W-2 employee when their W-2 for a tax year becomes available
 * (January of the following year). Fires at most once per year per employee:
 * notified years persist in app_settings. Content rules hold — the email
 * states the tax year and "log in to download", never amounts or SSN.
 */
export async function sendW2AvailableNotices(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const notified = await notifiedYears(db);

  const years = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const companyRows = await db.select({ legalName: company.legalName }).from(company).limit(1);
  const ctx: TemplateContext = {
    companyName: companyRows[0]?.legalName ?? "Payroll",
    appUrl: config.baseUrl,
  };

  let sent = 0;
  for (const { year } of years) {
    if (!isW2Available(year, today) || notified.includes(year)) continue;
    const rendered = tplW2Available(ctx, { taxYear: year });
    const marker = `w2-available:${year}`;
    for (const userId of await w2RecipientsForYear(db, year)) {
      await db.insert(emailOutbox).values({
        userId,
        eventType: EVENT_TYPE.w2Available,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}<!-- ${marker} -->`,
      });
      sent += 1;
    }
    notified.push(year);
    await db
      .insert(appSettings)
      .values({ key: W2_NOTIFIED_YEARS_KEY, value: notified, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [appSettings.key],
        set: { value: notified, updatedAt: new Date() },
      });
  }
  return { sent };
}
