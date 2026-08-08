/**
 * effectivePayslipAmounts tests (2026-07-31): the payslip must render the
 * ISSUED amounts when the snapshot documents legacy deviations — the 2026-03
 * Form 941 true-up (stored federal 490.73 / net 3203.27 ≠ engine 298.33 /
 * 3395.67, all synthetic fixture values). Without deviations the result
 * passes through verbatim.
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
      periodAmount: 4000,
      frequency: "monthly",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      payDate: "2026-03-15",
      company: { legalName: "Example Corp" },
      employee: { legalName: "Ada Lovelace", preferredName: null },
    },
    result: {
      grossPay: 4000,
      federalWithholding: 298.33,
      socialSecurity: 248,
      medicare: 58,
      stateWithholding: 0,
      totalDeductions: 604.33,
      netPay: 3395.67,
      employerSocialSecurity: 248,
      employerMedicare: 58,
      employerFUTA: 0,
      totalEmployerCost: 4306,
      ytdGross: 12000,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.1.0",
    ...(deviations ? { legacyDeviations: deviations } : {}),
  };
}

const MARCH_DEVIATIONS: PayslipSnapshot["legacyDeviations"] = [
  {
    category: "federal_withholding",
    stored: "490.73",
    recomputed: "298.33",
    reason: "Q1-2026 Form 941 reconciliation true-up",
  },
  {
    category: "net_pay",
    stored: "3203.27",
    recomputed: "3395.67",
    reason: "Q1-2026 Form 941 reconciliation true-up",
  },
];

describe("effectivePayslipAmounts", () => {
  it("passes the engine result through verbatim when there are no deviations", () => {
    const eff = effectivePayslipAmounts(snapshot());
    expect(eff.federalWithholding).toBe(298.33);
    expect(eff.netPay).toBe(3395.67);
    expect(eff.totalDeductions).toBe(604.33); // result's own total, not derived
    expect(eff.deviations).toEqual([]);
  });

  it("overrides to the ISSUED amounts and derives total as gross − net", () => {
    const eff = effectivePayslipAmounts(snapshot(MARCH_DEVIATIONS));
    expect(eff.federalWithholding).toBe(490.73); // what was actually withheld
    expect(eff.netPay).toBe(3203.27); // what was actually paid
    expect(eff.totalDeductions).toBe(796.73); // 4000 − 3203.27
    // Non-deviation categories are untouched.
    expect(eff.socialSecurity).toBe(248);
    expect(eff.medicare).toBe(58);
    expect(eff.deviations).toEqual([
      { label: "Federal Income Tax", stored: 490.73, recomputed: 298.33 },
      { label: "Net Pay", stored: 3203.27, recomputed: 3395.67 },
    ]);
  });

  it("renders a valid PDF from a deviation snapshot", async () => {
    const pdf = await renderPayslipPdf(snapshot(MARCH_DEVIATIONS));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
