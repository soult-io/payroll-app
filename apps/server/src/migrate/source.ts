/**
 * Legacy source reader — reads the `accounting` schema of an external
 * legacy payroll database. Raw SQL against an injectable executor so
 * the production CLI uses postgres-js over TCP and the tests use PGlite, with
 * identical SQL on both (same pattern as the app's own test harness).
 *
 * Column names below mirror the legacy source DDL verbatim.
 * Money arrives as NUMERIC strings;
 * DATE columns are normalized to ISO `YYYY-MM-DD` by {@link isoDate} because
 * postgres-js and PGlite disagree on the JS type for DATE.
 */

export interface SourceDb {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** DATE → "YYYY-MM-DD" regardless of driver (string | Date). */
export function isoDate(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error(`unexpected DATE value: ${String(value)}`);
}

/** TIMESTAMPTZ → Date (both drivers deliver Date; tolerate ISO strings). */
export function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`unexpected TIMESTAMPTZ value: ${String(value)}`);
}

export interface SourceEmployee {
  id: number;
  full_name: string;
  entity: string;
  created_at: unknown;
}

export interface SourceCompensation {
  id: number;
  employee_id: number;
  monthly_salary: string;
  effective_from: unknown;
  effective_to: unknown | null;
}

export interface SourceW4 {
  id: number;
  employee_id: number;
  tax_year: number;
  federal_exempt: boolean;
  effective_from: unknown | null;
  filed_date: unknown;
  renewal_deadline: unknown | null;
  note: string | null;
}

export interface SourceTaxConfig {
  tax_year: number;
  standard_deduction: string;
  social_security_rate: string;
  social_security_wage_cap: string;
  medicare_rate: string;
  medicare_additional_rate: string;
  medicare_additional_threshold: string;
  state_withholding_rate: string;
  employer_social_security_rate: string;
  employer_medicare_rate: string;
  futa_rate: string;
  futa_wage_cap: string;
}

export interface SourceBracket {
  id: number;
  tax_year: number;
  ordinal: number;
  min_amount: string;
  max_amount: string | null;
  rate: string;
}

export interface SourceRun {
  id: number;
  employee_id: number;
  month: number;
  year: number;
  pay_stub_path: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface SourceEntry {
  id: number;
  run_id: number;
  category: string;
  amount: string;
}

export interface SourceData {
  employees: SourceEmployee[];
  compensation: SourceCompensation[];
  w4Elections: SourceW4[];
  taxConfig: SourceTaxConfig[];
  taxBrackets: SourceBracket[];
  /** Chronological (year, month) — prior-YTD reconstruction depends on it. */
  runs: SourceRun[];
  entries: SourceEntry[];
  /** Tables the migration deliberately does NOT move (spec 9 "NOT migrated"). */
  skippedCounts: { table: string; rows: number }[];
  /** Runs carrying a pay_stub_path (files stay in the legacy document store — D5). */
  runsWithStubPath: number;
}

export async function readSource(db: SourceDb): Promise<SourceData> {
  const employees = await db.query<SourceEmployee>(
    `SELECT id, full_name, entity, created_at FROM accounting.employees ORDER BY id`,
  );
  const compensation = await db.query<SourceCompensation>(
    `SELECT id, employee_id, monthly_salary, effective_from, effective_to
     FROM accounting.compensation ORDER BY employee_id, effective_from`,
  );
  const w4Elections = await db.query<SourceW4>(
    `SELECT id, employee_id, tax_year, federal_exempt, effective_from, filed_date,
            renewal_deadline, note
     FROM accounting.w4_elections ORDER BY employee_id, tax_year`,
  );
  const taxConfig = await db.query<SourceTaxConfig>(
    `SELECT tax_year, standard_deduction, social_security_rate, social_security_wage_cap,
            medicare_rate, medicare_additional_rate, medicare_additional_threshold,
            state_withholding_rate, employer_social_security_rate, employer_medicare_rate,
            futa_rate, futa_wage_cap
     FROM accounting.tax_config ORDER BY tax_year`,
  );
  const taxBrackets = await db.query<SourceBracket>(
    `SELECT id, tax_year, ordinal, min_amount, max_amount, rate
     FROM accounting.tax_brackets ORDER BY tax_year, ordinal`,
  );
  const runs = await db.query<SourceRun>(
    `SELECT id, employee_id, month, year, pay_stub_path, created_at, updated_at
     FROM accounting.payroll_runs ORDER BY year, month`,
  );
  const entries = await db.query<SourceEntry>(
    `SELECT id, run_id, category, amount FROM accounting.payroll_entries ORDER BY run_id, category`,
  );

  const skippedCounts: { table: string; rows: number }[] = [];
  for (const table of ["time_off", "compliance_filings", "deposits"] as const) {
    try {
      const rows = await db.query<{ n: string | number }>(
        `SELECT count(*)::int AS n FROM accounting.${table}`,
      );
      skippedCounts.push({ table, rows: Number(rows[0]?.n ?? 0) });
    } catch {
      skippedCounts.push({ table, rows: -1 }); // table absent — nothing to skip
    }
  }
  const runsWithStubPath = runs.filter((r) => r.pay_stub_path !== null).length;

  return {
    employees,
    compensation,
    w4Elections,
    taxConfig,
    taxBrackets,
    runs,
    entries,
    skippedCounts,
    runsWithStubPath,
  };
}
