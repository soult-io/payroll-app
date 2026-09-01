import { describe, test, expect } from "vitest";

import { round2 } from "../src/money.js";
import {
  calculatePayroll,
  effectiveFutaRate,
  FUTA_STATUTORY_RATE,
  TAX_CONFIG,
} from "../src/payroll.js";
import type { PayrollInput } from "../src/payroll.js";

// Expected values below are computed BY HAND from the 2026 brackets in
// TAX_CONFIG — not by re-running the implementation — so a logic regression
// (e.g. a wrong bracket or rate) is actually caught rather than mirrored.
//
// The engine now takes fully RESOLVED inputs: the caller supplies the monthly
// wage, the DB-summed prior-YTD gross, the per-year tax config, and the W-4
// exempt election. It never reads module globals or derives YTD from the month
// number. Tests inject TAX_CONFIG as the taxConfig so they stay DB-free.

/** Build a PayrollInput with TAX_CONFIG injected and sensible defaults. */
function input(over: Partial<PayrollInput> & { monthlySalary: number }): PayrollInput {
  return {
    priorYtdGross: 0,
    taxConfig: TAX_CONFIG,
    federalExempt: false,
    ...over,
  };
}

describe("calculatePayroll — golden case ($10,000/mo, first month)", () => {
  const r = calculatePayroll(input({ monthlySalary: 10_000, priorYtdGross: 0 }));

  // Annual taxable = 120,000 - 16,100 = 103,900.
  // Fed tax = 12,400*.10 + 38,000*.12 + 53,500*.22
  //         = 1,240 + 4,560 + 11,770 = 17,570  →  /12 = 1,464.1666… → 1,464.17
  test("federal withholding (progressive brackets)", () => {
    expect(r.federalWithholding).toBe(1_464.17);
  });

  test("social security = 6.2% of salary below wage cap", () => {
    expect(r.socialSecurity).toBe(620.0); // 10,000 * 0.062
  });

  test("medicare = 1.45% with no additional below $200k YTD", () => {
    expect(r.medicare).toBe(145.0); // 10,000 * 0.0145
  });

  test("state withholding is zero (rate 0)", () => {
    expect(r.stateWithholding).toBe(0);
  });

  test("total deductions and net pay", () => {
    expect(r.totalDeductions).toBe(2_229.17); // 1,464.1666 + 620 + 145
    expect(r.netPay).toBe(7_770.83); // 10,000 - 2,229.1666
  });

  test("employer-side taxes", () => {
    expect(r.employerSocialSecurity).toBe(620.0);
    expect(r.employerMedicare).toBe(145.0);
    expect(r.employerFUTA).toBe(42.0); // 7,000 wage base * 0.006
    expect(r.totalEmployerCost).toBe(10_807.0); // 10,000 + 620 + 145 + 42
  });

  test("ytd gross = prior YTD + this month's gross", () => {
    expect(r.ytdGross).toBe(10_000);
  });
});

describe("YTD gross is prior-YTD + this month (DB-summed prior, not wage×month)", () => {
  test("prior YTD accumulates onto this month's gross", () => {
    const r = calculatePayroll(input({ monthlySalary: 4_250, priorYtdGross: 18_000 }));
    expect(r.ytdGross).toBe(22_250); // 18,000 prior + 4,250 — the exact bug being fixed
  });
});

describe("Social Security wage cap ($184,500) — driven by prior-YTD gross", () => {
  test("partial SS in the month earnings cross the cap", () => {
    // $50k/mo, prior YTD = 150,000; only 34,500 of this month is still under
    // the 184,500 cap → 34,500 * 0.062 = 2,139.00
    const r = calculatePayroll(input({ monthlySalary: 50_000, priorYtdGross: 150_000 }));
    expect(r.socialSecurity).toBe(2_139.0);
    expect(r.employerSocialSecurity).toBe(2_139.0);
  });

  test("no SS once prior YTD already exceeds the cap", () => {
    // $50k/mo, prior YTD = 200,000 > 184,500 → SS = 0
    const r = calculatePayroll(input({ monthlySalary: 50_000, priorYtdGross: 200_000 }));
    expect(r.socialSecurity).toBe(0);
    expect(r.employerSocialSecurity).toBe(0);
  });
});

describe("FUTA wage base ($7,000) — driven by prior-YTD gross", () => {
  test("charged on the first $7,000 when no prior YTD", () => {
    const r = calculatePayroll(input({ monthlySalary: 10_000, priorYtdGross: 0 }));
    expect(r.employerFUTA).toBe(42.0); // 7,000 * 0.006
  });

  test("zero once the wage base is exhausted by prior YTD", () => {
    const r = calculatePayroll(input({ monthlySalary: 10_000, priorYtdGross: 10_000 }));
    expect(r.employerFUTA).toBe(0);
  });

  test("partial FUTA when this month straddles the $7,000 base", () => {
    // prior YTD 4,000; only 3,000 of the base remains → 3,000 * 0.006 = 18.00
    const r = calculatePayroll(input({ monthlySalary: 4_000, priorYtdGross: 4_000 }));
    expect(r.employerFUTA).toBe(18.0);
  });
});

describe("Additional Medicare (0.9% above $200k YTD) — driven by prior-YTD gross", () => {
  test("not applied at exactly the threshold", () => {
    // $50k/mo, prior YTD 150,000 → YTD = 200,000 (not > 200,000) → plain 1.45%
    const r = calculatePayroll(input({ monthlySalary: 50_000, priorYtdGross: 150_000 }));
    expect(r.medicare).toBe(725.0); // 50,000 * 0.0145
  });

  test("applied to the portion of YTD above the threshold", () => {
    // $50k/mo, prior YTD 200,000 → YTD = 250,000; whole 50,000 is above 200,000
    // 50,000 * 0.0145 + 50,000 * 0.009 = 725 + 450 = 1,175.00
    const r = calculatePayroll(input({ monthlySalary: 50_000, priorYtdGross: 200_000 }));
    expect(r.medicare).toBe(1_175.0);
  });
});

describe("invariants", () => {
  for (const [salary, prior] of [
    [10_000, 0],
    [50_000, 200_000],
    [3_000, 18_000],
    [184_500, 0],
  ] as const) {
    test(`net + deductions ≈ gross ($${salary}/mo, prior $${prior})`, () => {
      const r = calculatePayroll(input({ monthlySalary: salary, priorYtdGross: prior }));
      // independent per-field rounding can drift by at most a cent
      expect(Math.abs(r.netPay + r.totalDeductions - r.grossPay)).toBeLessThanOrEqual(0.01);
    });

    test(`all money fields rounded to ≤2 decimals ($${salary}/mo, prior $${prior})`, () => {
      const r = calculatePayroll(input({ monthlySalary: salary, priorYtdGross: prior }));
      for (const v of [
        r.federalWithholding,
        r.socialSecurity,
        r.medicare,
        r.totalDeductions,
        r.netPay,
        r.employerSocialSecurity,
        r.employerMedicare,
        r.employerFUTA,
        r.totalEmployerCost,
      ]) {
        expect(round2(v)).toBe(v);
      }
    });
  }
});

describe("W-4 exempt from federal withholding", () => {
  // Synthetic fixture: a W-4 filed 2026-03-17 elects EXEMPT for the 2026
  // calendar year. At $4,250/mo the expected numbers are:
  //   Federal W/H $0.00, SS $263.50 (4,250*.062), Medicare $61.63 (4,250*.0145),
  //   Total deductions $325.13, Net $3,924.87 — all computed by hand here.
  const exempt = calculatePayroll(input({ monthlySalary: 4_250, federalExempt: true }));
  const normal = calculatePayroll(input({ monthlySalary: 4_250, federalExempt: false }));

  test("federal withholding is zero when exempt", () => {
    expect(exempt.federalWithholding).toBe(0);
  });

  test("default (non-exempt) still computes withholding from brackets", () => {
    // Annual taxable = 51,000 - 16,100 = 34,900.
    // Fed tax = 12,400*.10 + 22,500*.12 = 1,240 + 2,700 = 3,940 → /12 = 328.33
    expect(normal.federalWithholding).toBe(328.33);
  });

  test("exempt zeroes ONLY federal — FICA and employer taxes unchanged", () => {
    expect(exempt.socialSecurity).toBe(263.5); // 4,250 * 0.062
    expect(exempt.medicare).toBe(61.63); // 4,250 * 0.0145
    expect(exempt.socialSecurity).toBe(normal.socialSecurity);
    expect(exempt.medicare).toBe(normal.medicare);
    expect(exempt.employerSocialSecurity).toBe(normal.employerSocialSecurity);
    expect(exempt.employerMedicare).toBe(normal.employerMedicare);
    expect(exempt.employerFUTA).toBe(normal.employerFUTA);
  });

  test("exempt total deductions $325.13 and net pay reconcile to the hand math", () => {
    expect(exempt.totalDeductions).toBe(325.13); // 0 + 263.50 + 61.63
    expect(exempt.netPay).toBe(3_924.87); // 4,250.00 − 325.13
    // Net pay and total deductions reconcile exactly to gross — no per-field
    // rounding drift (61.625 → 61.63 is the half-cent case).
    expect(exempt.netPay + exempt.totalDeductions).toBe(exempt.grossPay);
  });
});

describe("TAX_CONFIG sanity", () => {
  test("federal brackets are contiguous and ascending", () => {
    const b = TAX_CONFIG.federalBrackets;
    for (let i = 1; i < b.length; i++) {
      const prev = b[i - 1];
      const cur = b[i];
      if (prev === undefined || cur === undefined) throw new Error(`bracket ${i} missing`);
      expect(cur.min).toBe(prev.max);
    }
    expect(b[0]?.min).toBe(0);
    expect(b.at(-1)?.max).toBe(Infinity);
  });

  test("state withholding is modeled as a rate (currently 0)", () => {
    expect(TAX_CONFIG.stateWithholdingRate).toBe(0);
  });
});

describe("effectiveFutaRate (PAY-18)", () => {
  test("full SUTA credit nets to exactly 0.006 — no float residue", () => {
    // 0.06 - 0.054 is 0.005999999999999997 in IEEE-754; the helper must
    // round to NUMERIC(6,5) precision so the mirrored futa_rate is exact.
    expect(effectiveFutaRate(0.054)).toBe(0.006);
  });

  test("no SUTA credit yields the full statutory 6% ($420/employee case)", () => {
    expect(effectiveFutaRate(0)).toBe(FUTA_STATUTORY_RATE);
  });

  test("partial credit rounds to 5-decimal precision", () => {
    expect(effectiveFutaRate(0.051)).toBe(0.009);
  });

  test("default configs carry the full credit and stay at 0.6% net", () => {
    expect(TAX_CONFIG.sutaCreditRate).toBe(0.054);
    expect(effectiveFutaRate(TAX_CONFIG.sutaCreditRate)).toBe(0.006);
    expect(TAX_CONFIG.futaRate).toBe(effectiveFutaRate(TAX_CONFIG.sutaCreditRate));
  });
});
