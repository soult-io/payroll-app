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
  /**
   * SUTA credit claimed against the statutory FUTA rate (PAY-18). 0.054 =
   * the standard full credit (employer pays state unemployment insurance);
   * 0 = no SUTA paid → the full 6.0% applies. Credit-reduction states are a
   * partial value (e.g. 0.051 → 0.9% net).
   */
  sutaCreditRate: number;
}

/** Statutory FUTA rate (IRC §3301) — before any SUTA credit (§3302). */
export const FUTA_STATUTORY_RATE = 0.06;

/**
 * Net FUTA rate for a year: statutory minus the configured SUTA credit,
 * rounded to NUMERIC(6,5) precision so 0.06 − 0.054 is exactly 0.006 (never
 * the float 0.005999…).
 */
export function effectiveFutaRate(sutaCreditRate: number): number {
  return Math.round((FUTA_STATUTORY_RATE - sutaCreditRate) * 100_000) / 100_000;
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
  sutaCreditRate: 0.054,
};

/**
 * 2025 statutory tables — needed to reconcile 2025 payroll history and to
 * re-create 2025 payslips. Golden check used across the test suites: at a
 * synthetic $4,000/mo, the annual-bracket method gives $48,000 − $15,000 std
 * deduction = $33,000 taxable → $3,721.50/yr → $310.13/mo. Single-filer 2025
 * brackets; SS wage cap $176,100.
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
  sutaCreditRate: 0.054,
};

/**
 * Seed W-4 election for the synthetic fixture employee (Example Corp).
 *
 * The W-4 filed 2026-03-17 claims EXEMPT from federal income-tax withholding
 * (FEIE covers the full salary). It is EFFECTIVE-DATED — it applies to pay
 * periods from 2026-04-01 onward (the first period after filing), NOT
 * retroactively to the whole 2026 tax year. So 2026 Jan–Mar still withholds
 * federal and only Apr+ is $0.
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
  // Filing provenance for the DB-seeded w4_elections row (synthetic fixture).
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
   * Pay periods per year — 12 (monthly), 24 (semimonthly), 26 (biweekly),
   * or 52 (weekly). Annualization = monthlySalary × periodsPerYear and
   * withholding de-annualizes by the same factor. Optional: when omitted the
   * legacy monthly behavior (12) applies, bit-identical to the pre-frequency
   * engine.
   */
  periodsPerYear?: 12 | 24 | 26 | 52;
  /**
   * 2020+ W-4 adjustment amounts (IRS Pub 15-T annual wage method). All
   * optional; absent/zero fields leave the legacy computation untouched.
   * Filing-status bracket selection happens at config-resolution time (the
   * caller passes the matching bracket set inside taxConfig).
   */
  w4?: W4Adjustments;
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
  /**
   * PAY-13: resolved per-state withholding config + election for the
   * employee's work state. When PRESENT, state withholding is computed by
   * computeStateWithholding (annualized EDD Method B / IL-700-T formula
   * method); when ABSENT, the legacy flat `stateWithholdingRate` path applies
   * bit-identically (pre-PAY-13 behavior).
   */
  state?: { config: StateTaxConfig; election?: StateElectionInput };
}

/**
 * 2020+ W-4 dollar adjustments (Pub 15-T Worksheet 1A / automated percentage
 * method): annual `other_income` (4a) and `deductions_amount` (4b) shift the
 * wage base before the standard deduction; `dependents_amount` (step 3) is a
 * credit subtracted AFTER the bracket computation; `extra_withholding` (4c) is
 * a flat per-period add-on.
 */
export interface W4Adjustments {
  /** Step 3 — annual dependent credit (dollars). */
  dependentsAmount?: number;
  /** Step 4a — other annual income added to the wage base. */
  otherIncome?: number;
  /** Step 4b — annual deductions subtracted from the wage base. */
  deductionsAmount?: number;
  /** Step 4c — extra withholding PER PAY PERIOD. */
  extraWithholding?: number;
}

/** Canonical frequency → periods-per-year map (compensation.frequency). */
export const PERIODS_PER_YEAR = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
} as const;

export type PayFrequency = keyof typeof PERIODS_PER_YEAR;

// ---------------------------------------------------------------------------
// PAY-13 phase 1 — per-state income-tax withholding
// ---------------------------------------------------------------------------

/**
 * Resolved per-state withholding config for one tax year (from
 * state_tax_configs + state_tax_brackets, post filing-status fallback).
 * Which optional fields a state uses depends on its form — see the schema
 * comment on stateTaxConfigs and packages/db/src/seeds/state-taxes/README.md.
 */
export interface StateTaxConfig {
  /** State code as resolved ('CA' even when the bracket set came from 'CA:married_joint'). */
  state: string;
  year: number;
  kind: "none" | "flat" | "progressive";
  /** kind='flat': rate on the allowance-reduced wage base. */
  flatRate?: number;
  /** Annual standard deduction before brackets (CA). */
  standardDeduction?: number;
  /** Alt values when regular allowances >= altMinAllowances (CA married 2+). */
  standardDeductionAlt?: number;
  altMinAllowances?: number;
  /** Annual wage floor: at or below it, withhold $0 (CA). */
  lowIncomeExemption?: number;
  lowIncomeExemptionAlt?: number;
  /** Annual wage-base deduction per REGULAR allowance (IL line 1). */
  allowanceDeduction?: number;
  /** Annual after-bracket credit per REGULAR allowance (CA DE 4). */
  allowanceCredit?: number;
  /** Annual wage-base deduction per ADDITIONAL allowance (CA AWAID / IL line 2). */
  additionalAllowanceDeduction?: number;
  /** kind='progressive': annual brackets (exclusive max; Infinity = top). */
  brackets?: FederalBracket[];
}

/** The employee's effective-dated state election (state_withholding_elections). */
export interface StateElectionInput {
  /** Regular allowances (IL-W-4 line 1 / DE 4 item 1). */
  allowances?: number;
  /** Estimated-deduction allowances (DE 4 item 2 / IL-W-4 line 2). */
  additionalAllowances?: number;
  /** Flat per-period add-on (IL-W-4 line 3 / DE 4 item 3). */
  extraWithholding?: number;
  /** Exempt from STATE withholding only (FICA/federal untouched). */
  exempt?: boolean;
}

function bracketTax(taxable: number, brackets: FederalBracket[]): number {
  let tax = 0;
  let remaining = taxable;
  for (const bracket of brackets) {
    const inBracket = Math.min(remaining, bracket.max - bracket.min);
    if (inBracket <= 0) break;
    tax += inBracket * bracket.rate;
    remaining -= inBracket;
  }
  return tax;
}

/**
 * Annualized state withholding (EDD Method B / IL-700-T formula method).
 * Returns the PER-PERIOD amount. Optional config fields default to absent =
 * unused, so a state only models what its form actually publishes.
 */
export function computeStateWithholding(
  annualGross: number,
  periodsPerYear: number,
  config: StateTaxConfig,
  election: StateElectionInput,
): number {
  if (config.kind === "none" || election.exempt) return 0;
  const allowances = election.allowances ?? 0;
  const additional = election.additionalAllowances ?? 0;
  const useAlt = config.altMinAllowances !== undefined && allowances >= config.altMinAllowances;

  const lowIncome = pick(config.lowIncomeExemption, config.lowIncomeExemptionAlt, useAlt);
  if (lowIncome !== undefined && annualGross <= lowIncome) return 0;

  const standardDeduction = pick(config.standardDeduction, config.standardDeductionAlt, useAlt);
  const base = stateWageBase(annualGross, config, allowances, additional, standardDeduction);
  const annualTax = stateAnnualTax(base, config, allowances);

  return annualTax / periodsPerYear + (election.extraWithholding ?? 0);
}

/** Alt-variant field resolution: the alt value applies when the allowance count crosses altMinAllowances. */
function pick(
  base: number | undefined,
  alt: number | undefined,
  useAlt: boolean,
): number | undefined {
  return useAlt ? (alt ?? base) : base;
}

/** Allowance/deduction-reduced annual wage base (IL lines 1–2, CA SD + AWAID), floored at 0. */
function stateWageBase(
  annualGross: number,
  config: StateTaxConfig,
  allowances: number,
  additional: number,
  standardDeduction: number | undefined,
): number {
  const reduced =
    annualGross -
    additional * (config.additionalAllowanceDeduction ?? 0) -
    allowances * (config.allowanceDeduction ?? 0) -
    (standardDeduction ?? 0);
  return Math.max(0, reduced);
}

/** Annual tax on the wage base: flat rate or bracket walk, then per-allowance credits (floor $0). */
function stateAnnualTax(base: number, config: StateTaxConfig, allowances: number): number {
  const grossTax =
    config.kind === "flat"
      ? base * (config.flatRate ?? 0)
      : bracketTax(base, config.brackets ?? []);
  return Math.max(0, grossTax - allowances * (config.allowanceCredit ?? 0));
}

/**
 * Engine version recorded in every run_snapshot (spec payroll-engine snapshot
 * contract). Bump minor on additive changes.
 * 0.3.0: PAY-13 — optional per-state withholding input (state config + election).
 */
export const ENGINE_VERSION = "0.3.0";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: vendored engine — must stay structurally identical to mcp-accounting's payroll.ts
export function calculatePayroll(input: PayrollInput): PayrollResult {
  const { monthlySalary, priorYtdGross, taxConfig, federalExempt } = input;
  const periodsPerYear = input.periodsPerYear ?? 12;
  if (![12, 24, 26, 52].includes(periodsPerYear)) {
    throw new RangeError(`periodsPerYear must be 12, 24, 26 or 52 — got ${periodsPerYear}`);
  }
  const w4 = input.w4 ?? {};
  const otherIncome = w4.otherIncome ?? 0;
  const deductionsAmount = w4.deductionsAmount ?? 0;
  const dependentsAmount = w4.dependentsAmount ?? 0;
  const extraWithholding = w4.extraWithholding ?? 0;
  const ytdGross = priorYtdGross + monthlySalary;

  // Pub 15-T annual wage method: adjust the annualized wage by other income
  // and deductions BEFORE the standard deduction. With zero adjustments and
  // periodsPerYear=12 every intermediate value is IEEE-identical to the
  // legacy monthly path.
  const annualGross = monthlySalary * periodsPerYear;
  const adjustedAnnualWage = annualGross + otherIncome - deductionsAmount;
  const annualTaxable = Math.max(0, adjustedAnnualWage - taxConfig.standardDeduction);
  let annualFederalTax = 0;
  let remaining = annualTaxable;
  for (const bracket of taxConfig.federalBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min);
    if (taxableInBracket <= 0) break;
    annualFederalTax += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
  }
  // Dependent credits come off AFTER the bracket computation (floor $0).
  const afterCredits = Math.max(0, annualFederalTax - dependentsAmount);
  // An exempt W-4 zeroes federal income-tax withholding only; FICA still
  // applies. Extra withholding is a flat per-period add-on.
  const federalWithholding = federalExempt ? 0 : afterCredits / periodsPerYear + extraWithholding;

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

  // PAY-13: per-state withholding from the resolved state config when the
  // employee has a work state; the legacy flat-rate path otherwise
  // (bit-identical for runs predating PAY-13 / without a work state).
  const stateWithholding = input.state
    ? computeStateWithholding(
        annualGross,
        periodsPerYear,
        input.state.config,
        input.state.election ?? {},
      )
    : monthlySalary * taxConfig.stateWithholdingRate;

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
