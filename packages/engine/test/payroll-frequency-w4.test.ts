/**
 * Frequency generalization + 2020+ W-4 fields (step 3, spec payroll-engine).
 *
 * Every expected value below is computed BY HAND from IRS Pub 15-T's annual
 * wage method against the 2025 single brackets in TAX_CONFIG_2025 (or an
 * inline married-joint fixture) — never by re-running the implementation.
 * The math is documented inline per case so a bracket/rate regression is
 * caught, not mirrored.
 *
 * Hand-computation reference (2025 single, std deduction $15,000):
 *   10%  $0–$11,925        → $1,192.50 at the top of the bracket
 *   12%  $11,925–$48,475   → $36,550 × .12 = $4,386.00
 *   22%  $48,475–$103,350  → per-dollar
 */

import { describe, test, expect } from "vitest";

import {
  calculatePayroll,
  TAX_CONFIG,
  TAX_CONFIG_2025,
  PERIODS_PER_YEAR,
  type PayrollInput,
  type TaxConfig,
} from "../src/payroll.js";

function input(over: Partial<PayrollInput> & { monthlySalary: number }): PayrollInput {
  return {
    priorYtdGross: 0,
    taxConfig: TAX_CONFIG_2025,
    federalExempt: false,
    ...over,
  };
}

/** 2025 married-filing-jointly fixture (Pub 15-T): std $30,000, 10% to $23,850, 12% to $96,950. */
const MFJ_2025: TaxConfig = {
  ...TAX_CONFIG_2025,
  standardDeduction: 30_000,
  federalBrackets: [
    { min: 0, max: 23_850, rate: 0.1 },
    { min: 23_850, max: 96_950, rate: 0.12 },
    { min: 96_950, max: 206_700, rate: 0.22 },
    { min: 206_700, max: 394_600, rate: 0.24 },
    { min: 394_600, max: 501_050, rate: 0.32 },
    { min: 501_050, max: 751_600, rate: 0.35 },
    { min: 751_600, max: Infinity, rate: 0.37 },
  ],
};

describe("frequency generalization (periodsPerYear)", () => {
  test("semimonthly (24): $3,000/period → federal $310.58", () => {
    // Annual = 3,000 × 24 = 72,000; taxable = 72,000 − 15,000 = 57,000.
    // Tax = 1,192.50 + 4,386.00 + (57,000 − 48,475) × .22
    //     = 1,192.50 + 4,386.00 + 1,875.50 = 7,454.00 → /24 = 310.58333… → 310.58
    const r = calculatePayroll(input({ monthlySalary: 3_000, periodsPerYear: 24 }));
    expect(r.federalWithholding).toBe(310.58);
    // FICA is per-period, unaffected by annualization.
    expect(r.socialSecurity).toBe(186.0); // 3,000 × .062
    expect(r.medicare).toBe(43.5); // 3,000 × .0145
    expect(r.netPay).toBe(2_459.92); // 3,000 − (310.58 + 186 + 43.50)
  });

  test("biweekly (26): $2,000/period → federal $161.60", () => {
    // Annual = 52,000; taxable = 37,000.
    // Tax = 1,192.50 + (37,000 − 11,925) × .12 = 1,192.50 + 3,009.00 = 4,201.50
    // → /26 = 161.59615… → 161.60
    const r = calculatePayroll(input({ monthlySalary: 2_000, periodsPerYear: 26 }));
    expect(r.federalWithholding).toBe(161.6);
  });

  test("weekly (52): $1,000/period → federal $80.80 (same annual wage as biweekly case)", () => {
    // Same $52,000 annual → same $4,201.50 annual tax → /52 = 80.79807… → 80.80
    const r = calculatePayroll(input({ monthlySalary: 1_000, periodsPerYear: 52 }));
    expect(r.federalWithholding).toBe(80.8);
  });

  test("omitted periodsPerYear stays bit-identical to legacy monthly", () => {
    // The 2026 golden case from payroll.test.ts: 10,000/mo → 1,464.17.
    const legacy = calculatePayroll(
      input({ monthlySalary: 10_000, taxConfig: TAX_CONFIG }),
    );
    const explicit = calculatePayroll(
      input({
        monthlySalary: 10_000,
        taxConfig: TAX_CONFIG,
        periodsPerYear: 12,
        w4: { dependentsAmount: 0, otherIncome: 0, deductionsAmount: 0, extraWithholding: 0 },
      }),
    );
    expect(explicit).toEqual(legacy);
    expect(legacy.federalWithholding).toBe(1_464.17);
  });

  test("invalid periodsPerYear throws", () => {
    // @ts-expect-error — deliberately out of the allowed union
    expect(() => calculatePayroll(input({ monthlySalary: 1_000, periodsPerYear: 10 }))).toThrow(
      RangeError,
    );
  });

  test("frequency map covers the schema enum", () => {
    expect(PERIODS_PER_YEAR).toEqual({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 });
  });
});

describe("2020+ W-4 fields (Pub 15-T annual wage method, $5,000/mo, 2025 single)", () => {
  // Base: annual 60,000; taxable 45,000.
  // Tax = 1,192.50 + (45,000 − 11,925) × .12 = 1,192.50 + 3,969.00 = 5,161.50
  // → /12 = 430.125 → 430.13 (half-up)

  test("baseline with explicit zero adjustments matches legacy path", () => {
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: {} }));
    expect(r.federalWithholding).toBe(430.13);
  });

  test("dependents_amount (step 3): $2,000 credit comes off after brackets", () => {
    // (5,161.50 − 2,000) / 12 = 3,161.50 / 12 = 263.45833… → 263.46
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: { dependentsAmount: 2_000 } }));
    expect(r.federalWithholding).toBe(263.46);
  });

  test("dependents_amount exceeding the tax floors at $0", () => {
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: { dependentsAmount: 6_000 } }));
    expect(r.federalWithholding).toBe(0);
  });

  test("other_income (4a): $12,000 raises the wage base before std deduction", () => {
    // Adjusted = 60,000 + 12,000 = 72,000; taxable 57,000 → tax 7,454.00
    // → /12 = 621.16666… → 621.17
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: { otherIncome: 12_000 } }));
    expect(r.federalWithholding).toBe(621.17);
  });

  test("deductions_amount (4b): $5,000 lowers the wage base", () => {
    // Adjusted = 55,000; taxable 40,000.
    // Tax = 1,192.50 + (40,000 − 11,925) × .12 = 1,192.50 + 3,369.00 = 4,561.50
    // → /12 = 380.125 → 380.13
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: { deductionsAmount: 5_000 } }));
    expect(r.federalWithholding).toBe(380.13);
  });

  test("other_income + deductions_amount combine (4a − 4b)", () => {
    // Adjusted = 60,000 + 12,000 − 5,000 = 67,000; taxable 52,000.
    // Tax = 1,192.50 + 4,386.00 + (52,000 − 48,475) × .22 = 1,192.50 + 4,386.00 + 775.50
    //     = 6,354.00 → /12 = 529.50
    const r = calculatePayroll(
      input({ monthlySalary: 5_000, w4: { otherIncome: 12_000, deductionsAmount: 5_000 } }),
    );
    expect(r.federalWithholding).toBe(529.5);
  });

  test("extra_withholding (4c): flat per-period add-on", () => {
    // 5,161.50 / 12 + 100 = 430.125 + 100 = 530.125 → 530.13
    const r = calculatePayroll(input({ monthlySalary: 5_000, w4: { extraWithholding: 100 } }));
    expect(r.federalWithholding).toBe(530.13);
  });

  test("federal_exempt still short-circuits to $0 even with other income", () => {
    const r = calculatePayroll(
      input({ monthlySalary: 5_000, federalExempt: true, w4: { otherIncome: 50_000 } }),
    );
    expect(r.federalWithholding).toBe(0);
    // FICA untouched by exemption.
    expect(r.socialSecurity).toBe(310.0);
    expect(r.medicare).toBe(72.5);
  });

  test("filing-status bracket selection: married_joint fixture ($5,000/mo)", () => {
    // Caller resolves the MFJ bracket set; engine consumes it. 2025 MFJ:
    // std 30,000 → taxable 30,000.
    // Tax = 23,850 × .10 + (30,000 − 23,850) × .12 = 2,385.00 + 738.00 = 3,123.00
    // → /12 = 260.25
    const r = calculatePayroll(input({ monthlySalary: 5_000, taxConfig: MFJ_2025 }));
    expect(r.federalWithholding).toBe(260.25);
  });
});
