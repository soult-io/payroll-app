/**
 * effectivePayslipAmounts tests (2026-07-31): the payslip must render the
 * ISSUED amounts when the snapshot documents legacy deviations — the 2026-03
 * Form 941 true-up (stored federal 472.73 / net 2759.52 ≠ engine 238.33 /
 * 2993.92). Without deviations the result passes through verbatim.
 */

import { describe, expect, it } from "vitest";
import {
  effectivePayslipAmounts,
  type PayslipSnapshot,
  renderPayslipPdf,
} from "@payroll/documents";

function snapshot(deviations?: PayslipSnapshot["legacyDeviations"]): PayslipSnapshot {
  return {
    inputs: {
      periodAmount: 3500,
      frequency: "monthly",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      payDate: "2026-03-15",
      company: { legalName: "SOULT IO LTD" },
      employee: { legalName: "Neilson Soult", preferredName: null },
    },
    result: {
      grossPay: 3500,
      federalWithholding: 238.33,
      socialSecurity: 217,
      medicare: 50.75,
      stateWithholding: 0,
      totalDeductions: 506.08,
      netPay: 2993.92,
      employerSocialSecurity: 217,
      employerMedicare: 50.75,
      employerFUTA: 0,
      totalEmployerCost: 3767.75,
      ytdGross: 10500,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.1.0",
    ...(deviations ? { legacyDeviations: deviations } : {}),
  };
}

const MARCH_DEVIATIONS: PayslipSnapshot["legacyDeviations"] = [
  {
    category: "federal_withholding",
    stored: "472.73",
    recomputed: "238.33",
    reason: "Q1-2026 Form 941 reconciliation true-up",
  },
  {
    category: "net_pay",
    stored: "2759.52",
    recomputed: "2993.92",
    reason: "Q1-2026 Form 941 reconciliation true-up",
  },
];

describe("effectivePayslipAmounts", () => {
  it("passes the engine result through verbatim when there are no deviations", () => {
    const eff = effectivePayslipAmounts(snapshot());
    expect(eff.federalWithholding).toBe(238.33);
    expect(eff.netPay).toBe(2993.92);
    expect(eff.totalDeductions).toBe(506.08); // result's own total, not derived
    expect(eff.deviations).toEqual([]);
  });

  it("overrides to the ISSUED amounts and derives total as gross − net", () => {
    const eff = effectivePayslipAmounts(snapshot(MARCH_DEVIATIONS));
    expect(eff.federalWithholding).toBe(472.73); // what was actually withheld
    expect(eff.netPay).toBe(2759.52); // what was actually paid
    expect(eff.totalDeductions).toBe(740.48); // 3500 − 2759.52
    // Non-deviation categories are untouched.
    expect(eff.socialSecurity).toBe(217);
    expect(eff.medicare).toBe(50.75);
    expect(eff.deviations).toEqual([
      { label: "Federal Income Tax", stored: 472.73, recomputed: 238.33 },
      { label: "Net Pay", stored: 2759.52, recomputed: 2993.92 },
    ]);
  });

  it("renders a valid PDF from a deviation snapshot", async () => {
    const pdf = await renderPayslipPdf(snapshot(MARCH_DEVIATIONS));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
