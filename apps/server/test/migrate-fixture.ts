/**
 * Migration test fixture — a PGlite that faithfully mimics the LEGACY source
 * (`second_brain.accounting`, mcp-accounting) plus synthetic issued runs.
 *
 * The DDL below is copied VERBATIM from stack-finance/mcp-accounting/src/db.ts
 * (final post-migration shape: payroll_runs header-only with employee_id,
 * w4_elections with effective_from). Seed values are the REAL ones from
 * stack-finance/mcp-accounting/src/seed.ts + payroll.ts constants — sole
 * employee Neilson Soult / SOULT IO LTD, the 2025→2026-03 $3,500/mo and
 * 2026-04+ $3,750/mo compensation schedule, the 2026 exempt W-4 effective
 * 2026-04-01, and the 2025 + 2026 statutory tables.
 *
 * Synthetic runs (2025 Jan–Dec, 2026 Jan–Jul) are computed by the VENDORED
 * engine itself (@payroll/engine — the same code that produced the legacy
 * data), so fixtures are self-consistent: the migration's reconstruction must
 * validate every one of them to the cent. A `corrupt` option perturbs one
 * stored entry by $0.01 to prove the halt path.
 */

import { PGlite } from "@electric-sql/pglite";
import { calculatePayroll, TAX_CONFIG, TAX_CONFIG_2025 } from "@payroll/engine";
import { round2 } from "@payroll/engine/money";
import type { SourceDb } from "../src/migrate/source.js";

// ---------------------------------------------------------------------------
// Source DDL (verbatim from mcp-accounting/src/db.ts)
// ---------------------------------------------------------------------------

const SOURCE_DDL = `
CREATE SCHEMA accounting;

CREATE TABLE accounting.time_off (
  id          SERIAL PRIMARY KEY,
  date        DATE NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('sick', 'vacation', 'holiday', 'other')),
  note        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE accounting.compliance_filings (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  tax_year    INTEGER NOT NULL,
  filed_date  DATE NOT NULL,
  method      TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, tax_year)
);

CREATE TABLE accounting.employees (
  id          SERIAL PRIMARY KEY,
  full_name   TEXT NOT NULL,
  entity      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE accounting.payroll_runs (
  id             SERIAL PRIMARY KEY,
  month          INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER NOT NULL,
  pay_stub_path  TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  employee_id    INTEGER NOT NULL REFERENCES accounting.employees(id),
  UNIQUE(employee_id, month, year)
);

CREATE TABLE accounting.deposits (
  id              SERIAL PRIMARY KEY,
  form            TEXT NOT NULL,
  tax_period      TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  deposit_date    DATE NOT NULL,
  eft_number      TEXT,
  method          TEXT DEFAULT 'EFTPS',
  status          TEXT DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  payroll_run_id  INTEGER REFERENCES accounting.payroll_runs(id),
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  created_by      TEXT DEFAULT 'neil',
  UNIQUE(form, tax_period, eft_number)
);

CREATE TABLE accounting.compensation (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES accounting.employees(id),
  monthly_salary  NUMERIC(12,2) NOT NULL,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, effective_from)
);

CREATE TABLE accounting.w4_elections (
  id                SERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES accounting.employees(id),
  tax_year          INTEGER NOT NULL,
  federal_exempt    BOOLEAN NOT NULL,
  effective_from    DATE,
  filed_date        DATE NOT NULL,
  renewal_deadline  DATE,
  note              TEXT DEFAULT '',
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, tax_year)
);

CREATE TABLE accounting.tax_config (
  tax_year                       INTEGER PRIMARY KEY,
  standard_deduction             NUMERIC(12,2) NOT NULL,
  social_security_rate           NUMERIC(6,5) NOT NULL,
  social_security_wage_cap       NUMERIC(12,2) NOT NULL,
  medicare_rate                  NUMERIC(6,5) NOT NULL,
  medicare_additional_rate       NUMERIC(6,5) NOT NULL,
  medicare_additional_threshold  NUMERIC(12,2) NOT NULL,
  state_withholding_rate         NUMERIC(6,5) NOT NULL,
  employer_social_security_rate  NUMERIC(6,5) NOT NULL,
  employer_medicare_rate         NUMERIC(6,5) NOT NULL,
  futa_rate                      NUMERIC(6,5) NOT NULL,
  futa_wage_cap                  NUMERIC(12,2) NOT NULL
);

CREATE TABLE accounting.tax_brackets (
  id          SERIAL PRIMARY KEY,
  tax_year    INTEGER NOT NULL,
  ordinal     INTEGER NOT NULL,
  min_amount  NUMERIC(12,2) NOT NULL,
  max_amount  NUMERIC(12,2),
  rate        NUMERIC(6,5) NOT NULL,
  UNIQUE(tax_year, ordinal)
);

CREATE TABLE accounting.payroll_entries (
  id          SERIAL PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES accounting.payroll_runs(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN (
                'gross_pay', 'federal_withholding', 'social_security', 'medicare',
                'state_withholding', 'net_pay', 'employer_social_security',
                'employer_medicare', 'employer_futa')),
  amount      NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(run_id, category)
);
`;

// ---------------------------------------------------------------------------
// Real seed values (mcp-accounting/src/seed.ts + payroll.ts constants)
// ---------------------------------------------------------------------------

export const LEGACY_EMPLOYEE = { fullName: "Neilson Soult", entity: "SOULT IO LTD" } as const;

export const LEGACY_COMPENSATION = [
  { monthlySalary: 3500, effectiveFrom: "2025-01-01", effectiveTo: "2026-03-31" },
  { monthlySalary: 3750, effectiveFrom: "2026-04-01", effectiveTo: null },
] as const;

export const LEGACY_W4 = {
  taxYear: 2026,
  federalExempt: true,
  effectiveFrom: "2026-04-01",
  filedDate: "2026-03-17",
  renewalDeadline: "2027-02-16",
  note: "FEIE covers full salary; exempt from 2026-04-01",
} as const;

/** Runs synthesized by the fixture: 2025 full year + 2026 Jan–Jul. */
export const FIXTURE_RUN_PERIODS: { year: number; month: number }[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ year: 2025, month: i + 1 })),
  ...Array.from({ length: 7 }, (_, i) => ({ year: 2026, month: i + 1 })),
];

function salaryOn(isoDate: string): number {
  for (const row of LEGACY_COMPENSATION) {
    if (row.effectiveFrom <= isoDate && (row.effectiveTo === null || isoDate <= row.effectiveTo)) {
      return row.monthlySalary;
    }
  }
  throw new Error(`no fixture compensation covers ${isoDate}`);
}

function exemptOn(isoDate: string): boolean {
  return (
    LEGACY_W4.federalExempt &&
    isoDate.slice(0, 4) === String(LEGACY_W4.taxYear) &&
    isoDate >= LEGACY_W4.effectiveFrom
  );
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

export interface SourceFixture {
  pglite: PGlite;
  source: SourceDb;
  /** source run id by "YYYY-MM" for targeted assertions/corruption. */
  runIds: Map<string, number>;
  close: () => Promise<void>;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test fixture builder; sequential DDL/seed script by nature
export async function createSourceFixture(
  opts: { withRuns?: boolean; corrupt?: { year: number; month: number; category?: string } } = {},
): Promise<SourceFixture> {
  const pglite = new PGlite("memory://");
  await pglite.exec(SOURCE_DDL);

  const source: SourceDb = {
    query: async <T>(text: string, params?: unknown[]): Promise<T[]> => {
      const res = await pglite.query<T>(text, params ?? []);
      return res.rows;
    },
    close: () => pglite.close(),
  };

  // ---- reference data (the real seed values) ----
  await pglite.query(`INSERT INTO accounting.employees (full_name, entity) VALUES ($1, $2)`, [
    LEGACY_EMPLOYEE.fullName,
    LEGACY_EMPLOYEE.entity,
  ]);
  for (const c of LEGACY_COMPENSATION) {
    await pglite.query(
      `INSERT INTO accounting.compensation (employee_id, monthly_salary, effective_from, effective_to)
       VALUES (1, $1, $2, $3)`,
      [c.monthlySalary, c.effectiveFrom, c.effectiveTo],
    );
  }
  await pglite.query(
    `INSERT INTO accounting.w4_elections
       (employee_id, tax_year, federal_exempt, effective_from, filed_date, renewal_deadline, note)
     VALUES (1, $1, $2, $3, $4, $5, $6)`,
    [
      LEGACY_W4.taxYear,
      LEGACY_W4.federalExempt,
      LEGACY_W4.effectiveFrom,
      LEGACY_W4.filedDate,
      LEGACY_W4.renewalDeadline,
      LEGACY_W4.note,
    ],
  );
  for (const cfg of [TAX_CONFIG_2025, TAX_CONFIG]) {
    await pglite.query(
      `INSERT INTO accounting.tax_config
         (tax_year, standard_deduction, social_security_rate, social_security_wage_cap,
          medicare_rate, medicare_additional_rate, medicare_additional_threshold,
          state_withholding_rate, employer_social_security_rate, employer_medicare_rate,
          futa_rate, futa_wage_cap)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        cfg.year,
        cfg.standardDeduction,
        cfg.socialSecurityRate,
        cfg.socialSecurityWageCap,
        cfg.medicareRate,
        cfg.medicareAdditionalRate,
        cfg.medicareAdditionalThreshold,
        cfg.stateWithholdingRate,
        cfg.employerSocialSecurityRate,
        cfg.employerMedicareRate,
        cfg.futaRate,
        cfg.futaWageCap,
      ],
    );
    for (const [i, b] of cfg.federalBrackets.entries()) {
      await pglite.query(
        `INSERT INTO accounting.tax_brackets (tax_year, ordinal, min_amount, max_amount, rate)
         VALUES ($1, $2, $3, $4, $5)`,
        [cfg.year, i + 1, b.min, b.max === Infinity ? null : b.max, b.rate],
      );
    }
  }

  // Rows in the NOT-migrated tables, so the skipped-report has something to say.
  await pglite.query(
    `INSERT INTO accounting.time_off (date, type, note) VALUES ('2026-08-03', 'vacation', 'summer')`,
  );
  await pglite.query(
    `INSERT INTO accounting.compliance_filings (name, tax_year, filed_date) VALUES ('941 Q1', 2026, '2026-04-30')`,
  );

  // ---- synthetic issued runs, computed by the vendored engine ----
  const runIds = new Map<string, number>();
  if (opts.withRuns ?? true) {
    const ytd = new Map<number, number>();
    for (const { year, month } of FIXTURE_RUN_PERIODS) {
      const mm = String(month).padStart(2, "0");
      const periodStart = `${year}-${mm}-01`;
      const taxConfig = year === 2025 ? TAX_CONFIG_2025 : TAX_CONFIG;
      const priorYtdGross = ytd.get(year) ?? 0;
      const result = calculatePayroll({
        monthlySalary: salaryOn(periodStart),
        periodsPerYear: 12,
        priorYtdGross,
        taxConfig,
        federalExempt: exemptOn(periodStart),
      });
      // Approximate the legacy issue timestamp (late the following period-end).
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const createdAt = `${year}-${mm}-${String(lastDay).padStart(2, "0")}T18:00:00Z`;
      // One run carries a pay_stub_path (files stay in Nextcloud — D5).
      const stubPath = year === 2026 && month === 3 ? "Payroll/2026/2026-03 payslip.pdf" : null;
      const inserted = await pglite.query<{ id: number }>(
        `INSERT INTO accounting.payroll_runs (employee_id, month, year, pay_stub_path, created_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $4) RETURNING id`,
        [month, year, stubPath, createdAt],
      );
      const runId = inserted.rows[0]!.id;
      runIds.set(`${year}-${mm}`, runId);

      const entries: [string, number][] = [
        ["gross_pay", result.grossPay],
        ["federal_withholding", result.federalWithholding],
        ["social_security", result.socialSecurity],
        ["medicare", result.medicare],
        ["state_withholding", result.stateWithholding],
        ["net_pay", result.netPay],
        ["employer_social_security", result.employerSocialSecurity],
        ["employer_medicare", result.employerMedicare],
        ["employer_futa", result.employerFUTA],
      ];
      for (const [category, amount] of entries) {
        const corrupted =
          opts.corrupt &&
          opts.corrupt.year === year &&
          opts.corrupt.month === month &&
          (opts.corrupt.category ?? "federal_withholding") === category;
        await pglite.query(
          `INSERT INTO accounting.payroll_entries (run_id, category, amount) VALUES ($1, $2, $3)`,
          [runId, category, round2(amount + (corrupted ? 0.01 : 0))],
        );
      }
      ytd.set(year, round2(priorYtdGross + result.grossPay));
    }
    // A deposit pointing at the first run (skipped-table realism).
    await pglite.query(
      `INSERT INTO accounting.deposits (form, tax_period, amount, deposit_date, payroll_run_id)
       VALUES ('941', '2026 Q1', 1500.00, '2026-04-15', $1)`,
      [runIds.get("2026-01")!],
    );
  }

  return {
    pglite,
    source,
    runIds,
    close: async () => {
      await pglite.close();
    },
  };
}
