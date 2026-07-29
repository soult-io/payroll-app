/**
 * Property-based tests for the vendored engine (plan: fast-check PBT).
 *
 * These are INVARIANT tests over the public calculatePayroll API — they never
 * re-implement the math; they assert properties that must hold for every
 * input: monotonicity, cap/threshold behavior, cent-exact rounding, the
 * exempt-W-4 contract, and the legacy-path identity (periodsPerYear=12 must
 * be bit-identical to omitting it). Deterministic seeds → failures reproduce.
 *
 * Existing unit tests (54) are untouched; this file is additive.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  calculatePayroll,
  TAX_CONFIG,
  TAX_CONFIG_2025,
  type PayrollInput,
  type TaxConfig,
} from "../src/payroll.js";
import { round2 } from "../src/money.js";

/** Money arbitrary: non-negative dollars with ≤2dp (integer cents). */
const money = (max = 50_000) => fc.integer({ min: 0, max: max * 100 }).map((n) => n / 100);
const salary = money(25_000);
const priorYtd = money(300_000);
const yearConfig = fc.constantFrom<TaxConfig>(TAX_CONFIG, TAX_CONFIG_2025);

const base = (cfg: TaxConfig, monthlySalary: number, ytd: number): PayrollInput => ({
  monthlySalary,
  priorYtdGross: ytd,
  taxConfig: cfg,
  federalExempt: false,
});

const RUNS = { numRuns: 300 };

describe("engine properties (fast-check)", () => {
  it("federal withholding is monotonic non-decreasing in salary and never negative", () => {
    fc.assert(
      fc.property(yearConfig, salary, salary, priorYtd, (cfg, s1, s2, ytd) => {
        const [lo, hi] = s1 <= s2 ? [s1, s2] : [s2, s1];
        const wLo = calculatePayroll(base(cfg, lo, ytd)).federalWithholding;
        const wHi = calculatePayroll(base(cfg, hi, ytd)).federalWithholding;
        expect(wLo).toBeGreaterThanOrEqual(0);
        expect(wHi).toBeGreaterThanOrEqual(wLo);
      }),
      { seed: 4201, ...RUNS },
    );
  });

  it("withholding is continuous at bracket edges (±1¢/period rounding granularity)", () => {
    // Every annual taxable edge of both shipped configs: salary that lands
    // taxable income exactly on the edge, vs 1¢/month more.
    for (const cfg of [TAX_CONFIG, TAX_CONFIG_2025]) {
      const edges = cfg.federalBrackets.slice(1).map((b) => b.min);
      for (const edge of edges) {
        const atEdge = round2((edge + cfg.standardDeduction) / 12);
        const over = round2(atEdge + 0.01);
        const w1 = calculatePayroll(base(cfg, atEdge, 0)).federalWithholding;
        const w2 = calculatePayroll(base(cfg, over, 0)).federalWithholding;
        // A 1¢/month raise can never move the per-period withholding by more
        // than 1¢ after cent-rounding (no bracket "cliff"). round2 the
        // difference itself — IEEE subtraction noise must not count.
        expect(round2(Math.abs(w2 - w1))).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it("Social Security: zero at/above the cap, partial when crossing, never over-taxes", () => {
    fc.assert(
      fc.property(yearConfig, salary, priorYtd, (cfg, s, ytd) => {
        const cap = cfg.socialSecurityWageCap;
        const r = calculatePayroll(base(cfg, s, ytd));
        if (ytd >= cap) {
          expect(r.socialSecurity).toBe(0);
          expect(r.employerSocialSecurity).toBe(0);
        } else {
          // Taxable base this period can never exceed cap − priorYTD.
          const maxBase = Math.min(s, cap - ytd);
          expect(r.socialSecurity).toBeLessThanOrEqual(round2(maxBase * cfg.socialSecurityRate));
          expect(r.employerSocialSecurity).toBeLessThanOrEqual(
            round2(maxBase * cfg.employerSocialSecurityRate),
          );
          if (ytd + s > cap) {
            // Crossing month: exactly the remaining headroom is taxed.
            expect(r.socialSecurity).toBe(round2((cap - ytd) * cfg.socialSecurityRate));
          }
        }
      }),
      { seed: 4202, ...RUNS },
    );
  });

  it("additional Medicare only kicks in above the threshold, on the excess only", () => {
    fc.assert(
      fc.property(yearConfig, salary, priorYtd, (cfg, s, ytd) => {
        const r = calculatePayroll(base(cfg, s, ytd));
        const basePart = round2(s * cfg.medicareRate);
        if (ytd + s <= cfg.medicareAdditionalThreshold) {
          expect(r.medicare).toBe(basePart);
        } else {
          const excess = Math.min(s, ytd + s - cfg.medicareAdditionalThreshold);
          expect(r.medicare).toBe(round2(s * cfg.medicareRate + excess * cfg.medicareAdditionalRate));
        }
      }),
      { seed: 4203, ...RUNS },
    );
  });

  it("rounding invariants: cent-exact lines; net = gross − deductions; employer cost adds up", () => {
    fc.assert(
      fc.property(yearConfig, salary, priorYtd, (cfg, s, ytd) => {
        const r = calculatePayroll(base(cfg, s, ytd));
        for (const line of [
          r.federalWithholding,
          r.socialSecurity,
          r.medicare,
          r.stateWithholding,
          r.netPay,
          r.employerSocialSecurity,
          r.employerMedicare,
          r.employerFUTA,
        ]) {
          expect(round2(line)).toBe(line); // already cent-rounded, no float drift
        }
        const deductions = round2(
          r.federalWithholding + r.socialSecurity + r.medicare + r.stateWithholding,
        );
        expect(r.totalDeductions).toBe(deductions);
        expect(r.netPay).toBe(round2(s - deductions));
        // totalEmployerCost rounds the sum of the UNROUNDED employer parts
        // (engine rounds once at the end), so it can sit within 2¢ of the
        // sum-of-rounded-lines — rounding-order effect, not drift.
        const sumOfRounded = round2(
          s + r.employerSocialSecurity + r.employerMedicare + r.employerFUTA,
        );
        expect(Math.abs(r.totalEmployerCost - sumOfRounded)).toBeLessThanOrEqual(0.02);
      }),
      { seed: 4204, ...RUNS },
    );
  });

  it("exempt W-4 zeroes federal withholding while FICA still applies", () => {
    fc.assert(
      fc.property(yearConfig, salary, priorYtd, (cfg, s, ytd) => {
        const r = calculatePayroll({ ...base(cfg, s, ytd), federalExempt: true });
        expect(r.federalWithholding).toBe(0);
        const nonExempt = calculatePayroll(base(cfg, s, ytd));
        expect(r.socialSecurity).toBe(nonExempt.socialSecurity);
        expect(r.medicare).toBe(nonExempt.medicare);
        if (s * cfg.socialSecurityRate >= 0.005 && ytd < cfg.socialSecurityWageCap) {
          expect(r.socialSecurity).toBeGreaterThan(0);
        }
        if (s * cfg.medicareRate >= 0.005) {
          expect(r.medicare).toBeGreaterThan(0);
        }
      }),
      { seed: 4205, ...RUNS },
    );
  });

  it("periodsPerYear=12 is bit-identical to the legacy (omitted) path", () => {
    fc.assert(
      fc.property(yearConfig, salary, priorYtd, (cfg, s, ytd) => {
        const legacy = calculatePayroll(base(cfg, s, ytd));
        const explicit = calculatePayroll({ ...base(cfg, s, ytd), periodsPerYear: 12 });
        expect(explicit).toEqual(legacy);
      }),
      { seed: 4206, ...RUNS },
    );
  });
});
