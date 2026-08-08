import { describe, test, expect } from "vitest";

import { round2, reconcileNet } from "../src/money.js";
import { calculatePayroll, TAX_CONFIG } from "../src/payroll.js";

// Expected values are computed BY HAND (not by re-running the implementation) so a
// regression in the helpers is caught rather than mirrored.

describe("round2 — round to whole cents", () => {
  test("rounds a repeating fraction half-up", () => {
    // 17,570 / 12 = 1,464.1666… → 1,464.17
    expect(round2(1_464.16666666)).toBe(1_464.17);
  });

  test("rounds a half-cent up (Medicare 4,250*.0145 = 61.625 → 61.63)", () => {
    expect(round2(61.625)).toBe(61.63);
  });

  test("is a no-op on values already at cent precision", () => {
    expect(round2(263.5)).toBe(263.5);
    expect(round2(0)).toBe(0);
    expect(round2(1_295.63)).toBe(1_295.63);
  });

  test("absorbs binary-float sum error (0.1 + 0.2 → 0.30)", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("reconcileNet — gross, rounded deductions, adjustments", () => {
  test("sums rounded deductions, re-rounds the total, derives net", () => {
    // Exempt payslip, $4,250/mo: fed $0, SS $263.50, Medicare $61.63.
    // Total deductions = 0 + 263.50 + 61.63 = 325.13; net = 4,250 − 325.13 = 3,924.87.
    const r = reconcileNet(4_250, [0, 263.5, 61.63]);
    expect(r.totalDeductions).toBe(325.13);
    expect(r.totalAdjustments).toBe(0);
    expect(r.netPay).toBe(3_924.87);
  });

  test("golden $10,000/mo month 1 (fed 1,464.17, SS 620, med 145, state 0)", () => {
    // Total deductions = 2,229.17; net = 10,000 − 2,229.17 = 7,770.83.
    const r = reconcileNet(10_000, [1_464.17, 620, 145, 0]);
    expect(r.totalDeductions).toBe(2_229.17);
    expect(r.netPay).toBe(7_770.83);
  });

  test("subtracts adjustments from net and reports their rounded total", () => {
    // gross 5,000; deductions 100 + 50 = 150; adjustments 25 + 10.50 = 35.50.
    // net = 5,000 − 150 − 35.50 = 4,814.50.
    const r = reconcileNet(5_000, [100, 50], [25, 10.5]);
    expect(r.totalDeductions).toBe(150);
    expect(r.totalAdjustments).toBe(35.5);
    expect(r.netPay).toBe(4_814.5);
  });

  test("re-rounds the summed total so float drift cannot leak into net", () => {
    // 0.1 + 0.2 sums to 0.30000000000000004 in binary float; the total and net
    // must still land on clean cents.
    const r = reconcileNet(1, [0.1, 0.2]);
    expect(r.totalDeductions).toBe(0.3);
    expect(r.netPay).toBe(0.7);
  });

  test("net + deductions + adjustments reconcile back to gross (by construction)", () => {
    for (const [gross, deductions, adjustments] of [
      [4_250, [0, 263.5, 61.63], []],
      [10_000, [1_464.17, 620, 145, 0], []],
      [5_000, [100, 50], [25, 10.5]],
      [184_500, [40_000.55, 11_439, 2_675.25], [500]],
    ] as const) {
      const r = reconcileNet(gross, [...deductions], [...adjustments]);
      expect(round2(r.netPay + r.totalDeductions + r.totalAdjustments)).toBe(gross);
    }
  });
});

describe("reconcileNet is the single reconcile shared by payroll + paystub", () => {
  test("paystub-style 3-deduction reconcile matches calculatePayroll's net", () => {
    // The paystub path (paystubGenerate) reconciles fed/SS/medicare with no state
    // line; calculatePayroll includes a $0 state line. With state = 0 the two must
    // agree exactly — that agreement is the invariant this refactor guarantees.
    const payroll = calculatePayroll({
      monthlySalary: 4_250,
      priorYtdGross: 18_000,
      taxConfig: TAX_CONFIG,
      federalExempt: true,
    });
    const paystub = reconcileNet(4_250, [
      payroll.federalWithholding,
      payroll.socialSecurity,
      payroll.medicare,
    ]);
    expect(paystub.totalDeductions).toBe(payroll.totalDeductions);
    expect(paystub.netPay).toBe(payroll.netPay);
  });
});
