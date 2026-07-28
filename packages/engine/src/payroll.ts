/**
 * Payroll tax calculation — pure, deterministic logic.
 *
 * Extracted from http.ts so the high-stakes withholding math can be unit
 * tested without booting the HTTP server. No I/O, no side effects.
 *
 * The engine takes fully RESOLVED inputs — monthly wage, the DB-summed prior-YTD
 * gross, the per-year tax config, and the W-4 exempt election. It never reads a
 * module global for those and never derives YTD from a month number; the tool
 * layer resolves them from Postgres (the source of truth) and passes them in.
 * TAX_CONFIG / EMPLOYEE_W4 remain in code as the DB seed source and as test
 * fixtures (unit tests inject TAX_CONFIG as `taxConfig`).
 */

import { reconcileNet, round2 } from "./money.js";

interface FederalBracket {
  min: number;
  /** Upper edge (exclusive); `Infinity` for the open top bracket. */
  max: number;
  rate: number;
}

/** Statutory tax scalars + brackets for one tax year. */
export interface TaxConfig {
  year: number;
  standardDeduction: number;
  federalBrackets: FederalBracket[];
  socialSecurityRate: number;
  socialSecurityWageCap: number;
  medicareRate: number;
  medicareAdditionalRate: number;
  medicareAdditionalThreshold: number;
  /** State income-tax withholding as a rate applied to wages (0 today). */
  stateWithholdingRate: number;
  employerSocialSecurityRate: number;
  employerMedicareRate: number;
  futaRate: number;
  futaWageCap: number;
}

export const TAX_CONFIG: TaxConfig = {
  year: 2026,
  standardDeduction: 16_100,
  federalBrackets: [
    { min: 0, max: 12_400, rate: 0.1 },
    { min: 12_400, max: 50_400, rate: 0.12 },
    { min: 50_400, max: 105_700, rate: 0.22 },
    { min: 105_700, max: 201_775, rate: 0.24 },
    { min: 201_775, max: 256_225, rate: 0.32 },
    { min: 256_225, max: 640_600, rate: 0.35 },
    { min: 640_600, max: Infinity, rate: 0.37 },
  ],
  socialSecurityRate: 0.062,
  socialSecurityWageCap: 184_500,
  medicareRate: 0.0145,
  medicareAdditionalRate: 0.009,
  medicareAdditionalThreshold: 200_000,
  stateWithholdingRate: 0,
  employerSocialSecurityRate: 0.062,
  employerMedicareRate: 0.0145,
  futaRate: 0.006,
  futaWageCap: 7_000,
};

/**
 * 2025 statutory tables — needed to reconcile the 2025 payroll history and to
 * re-create 2025 payslips. Reproduces the issued 2025 stub's federal $250.13
 * (annual-bracket method: $42,000 − $15,000 std deduction = $27,000 taxable →
 * $3,001.50/yr → $250.13/mo). Single-filer 2025 brackets; SS wage cap $176,100.
 */
export const TAX_CONFIG_2025: TaxConfig = {
  year: 2025,
  standardDeduction: 15_000,
  federalBrackets: [
    { min: 0, max: 11_925, rate: 0.1 },
    { min: 11_925, max: 48_475, rate: 0.12 },
    { min: 48_475, max: 103_350, rate: 0.22 },
    { min: 103_350, max: 197_300, rate: 0.24 },
    { min: 197_300, max: 250_525, rate: 0.32 },
    { min: 250_525, max: 626_350, rate: 0.35 },
    { min: 626_350, max: Infinity, rate: 0.37 },
  ],
  socialSecurityRate: 0.062,
  socialSecurityWageCap: 176_100,
  medicareRate: 0.0145,
  medicareAdditionalRate: 0.009,
  medicareAdditionalThreshold: 200_000,
  stateWithholdingRate: 0,
  employerSocialSecurityRate: 0.062,
  employerMedicareRate: 0.0145,
  futaRate: 0.006,
  futaWageCap: 7_000,
};

/**
 * Employee W-4 election (Neilson Soult, SOULT IO LTD — sole W-2 employee).
 *
 * The W-4 filed 2026-03-17 claims EXEMPT from federal income-tax withholding
 * (Second Brain #2009): FEIE covers the full salary. It is EFFECTIVE-DATED — it
 * applies to pay periods from 2026-04-01 onward (the first period after filing),
 * NOT retroactively to the whole 2026 tax year. So 2026 Jan–Mar still withheld
 * federal (the issued paystubs confirm this) and only Apr+ is $0.
 *
 * An exempt W-4 expires annually (IRC §3402(n)) — a new W-4 must be filed by
 * 2027-02-16 or withholding reverts to the default tables. This constant is the
 * seed source + test fixture; at runtime the tools read the election from the
 * `accounting.w4_elections` table (dbResolveFederalExempt, effective-dated).
 */
export const EMPLOYEE_W4 = {
  federalExemptTaxYear: 2026,
  effectiveFrom: "2026-04-01",
  renewalDeadline: "2027-02-16",
  // Filing provenance for the DB-seeded w4_elections row (Second Brain #2009).
  filedDate: "2026-03-17",
  note: "FEIE covers full salary; exempt from 2026-04-01",
} as const;

// The exempt election is effective-dated, so a year-granular helper would
// encode the wrong (whole-year) model — use isFederalExemptOn (src/seed.ts) /
// dbResolveFederalExempt, which key off the pay-period date.

export interface PayrollResult {
  grossPay: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
  employerSocialSecurity: number;
  employerMedicare: number;
  employerFUTA: number;
  totalEmployerCost: number;
  ytdGross: number;
}

export interface PayrollInput {
  /** This month's gross wage (resolved from the compensation schedule). */
  monthlySalary: number;
  /**
   * Gross pay already earned in prior months this year — the SUM of the
   * `gross_pay` payroll_entries for months before this one, NOT `wage × month`.
   * Drives the SS wage-cap, additional-Medicare, and FUTA-base logic.
   */
  priorYtdGross: number;
  /** Resolved statutory config for the pay period's year (from tax_config + tax_brackets). */
  taxConfig: TaxConfig;
  /** Whether the on-file W-4 elects exempt from federal withholding for the year. */
  federalExempt: boolean;
}

export function calculatePayroll(input: PayrollInput): PayrollResult {
  const { monthlySalary, priorYtdGross, taxConfig, federalExempt } = input;
  const ytdGross = priorYtdGross + monthlySalary;

  const annualGross = monthlySalary * 12;
  const annualTaxable = Math.max(0, annualGross - taxConfig.standardDeduction);
  let annualFederalTax = 0;
  let remaining = annualTaxable;
  for (const bracket of taxConfig.federalBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min);
    if (taxableInBracket <= 0) break;
    annualFederalTax += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
  }
  // An exempt W-4 zeroes federal income-tax withholding only; FICA still applies.
  const federalWithholding = federalExempt ? 0 : annualFederalTax / 12;

  const ssThisMonth =
    priorYtdGross < taxConfig.socialSecurityWageCap
      ? Math.min(monthlySalary, taxConfig.socialSecurityWageCap - priorYtdGross) *
        taxConfig.socialSecurityRate
      : 0;

  let medicare = monthlySalary * taxConfig.medicareRate;
  if (ytdGross > taxConfig.medicareAdditionalThreshold) {
    const additionalBase = Math.min(
      monthlySalary,
      ytdGross - taxConfig.medicareAdditionalThreshold,
    );
    if (additionalBase > 0) {
      medicare += additionalBase * taxConfig.medicareAdditionalRate;
    }
  }

  const stateWithholding = monthlySalary * taxConfig.stateWithholdingRate;

  // Round each withholding to cents FIRST, then reconcile net via money.ts —
  // reconcileNet rounds the summed total so per-line rounding can't push net a
  // cent above the printed stub. The paystub (paystubGenerate) shares reconcileNet,
  // so its net and this one agree by construction.
  const roundedFederal = round2(federalWithholding);
  const roundedSocialSecurity = round2(ssThisMonth);
  const roundedMedicare = round2(medicare);
  const roundedState = round2(stateWithholding);
  const { totalDeductions, netPay } = reconcileNet(monthlySalary, [
    roundedFederal,
    roundedSocialSecurity,
    roundedMedicare,
    roundedState,
  ]);

  const employerSS =
    priorYtdGross < taxConfig.socialSecurityWageCap
      ? Math.min(monthlySalary, taxConfig.socialSecurityWageCap - priorYtdGross) *
        taxConfig.employerSocialSecurityRate
      : 0;
  const employerMedicare = monthlySalary * taxConfig.employerMedicareRate;
  const employerFUTA =
    priorYtdGross < taxConfig.futaWageCap
      ? Math.min(monthlySalary, taxConfig.futaWageCap - priorYtdGross) * taxConfig.futaRate
      : 0;

  return {
    grossPay: monthlySalary,
    federalWithholding: roundedFederal,
    socialSecurity: roundedSocialSecurity,
    medicare: roundedMedicare,
    stateWithholding: roundedState,
    totalDeductions,
    netPay,
    employerSocialSecurity: round2(employerSS),
    employerMedicare: round2(employerMedicare),
    employerFUTA: round2(employerFUTA),
    totalEmployerCost: round2(monthlySalary + employerSS + employerMedicare + employerFUTA),
    ytdGross,
  };
}
