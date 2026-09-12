/**
 * Field map for the bundled IRS Form 941 templates (PAY-16) — built by
 * dumping every AcroForm widget's full name, page, and rect from the real
 * PDFs (irs-prior/f941--2025.pdf Rev. March 2025, irs-pdf/f941.pdf Rev.
 * March 2026) and matching each box by position, then verified by filling a
 * sample and re-reading the values per field.
 *
 * Both revisions share the SAME field names and near-identical positions for
 * page 1 (entity area + Part 1 lines 1–15), page 2 (Parts 2–5), and the
 * EIN/name header of the page-3 payment voucher (Form 941-V). The revisions
 * differ only in: the line-4 checkbox name, the line-15 overpayment
 * checkbox names (2026 adds 15c–15e direct-deposit refund fields, left
 * blank), and the voucher's field numbering (f3_* → f4_*). f941FieldMap()
 * returns the shared map with the per-revision names resolved.
 *
 * Rect-verified anchors (612×792 pt, y from bottom; 2026 revision, 2025
 * within a few pt where noted):
 *
 * Page 1 entity area — EIN f1_1 x153 w44 (2 digits) + f1_2 x216 w172 (7
 * digits) at y708; name f1_3 y684; trade name f1_4 y660; street f1_5 y636;
 * city f1_6 / state f1_7 / ZIP f1_8 at y606; foreign f1_9–f1_11 at y576.
 * Quarter checkboxes c1_1[0..3] x425 at y685/669/653/637.
 *
 * Page 1 Part 1 (money boxes are split dollars w101/w65 + cents w21):
 * line 1 f1_12 y484; line 2 f1_13/14 y462; line 3 f1_15/16 y442; line 4
 * checkbox y423; line 5a f1_17–20 y390; 5b f1_21–24 y370; 5c f1_25–28
 * y350; 5d f1_29–32 y324; 5e f1_33/34 y302; 5f f1_35/36 y283; line 6
 * f1_37/38 y264; 7 f1_39/40 y245; 8 f1_41/42 y226; 9 f1_43/44 y207; 10
 * f1_45/46 y188; 11 f1_47/48 y169; 12 f1_49/50 y150; 13 f1_51/52 y125; 14
 * f1_53/54 y103; 15(a) f1_55/56 y84 (2025: y74) with the two overpayment
 * checkboxes to the right.
 *
 * Page 2 — header name f1_3 + EIN f1_1/f1_2 at y720. Line 16 checkboxes
 * c2_1[0] y675 (de minimis), c2_1[1] y626 (monthly), c2_1[2] y511
 * (semiweekly → Schedule B); monthly liabilities f2_1/2 (month 1, y592),
 * f2_3/4 (month 2, y570), f2_5/6 (month 3, y549), f2_7/8 (total, y527).
 * Line 17 c2_2[0] + final-date f2_9; line 18 c2_3[0]. Part 4 designee
 * c2_4[0..1] + f2_10–f2_12. Part 5 print-name/title/phone f2_13–f2_15
 * (left blank — wet signature). Paid-preparer c2_5[0] + f2_16–f2_24 (left
 * blank).
 *
 * Page 3 (Form 941-V voucher) — EIN f1_1/f1_2 at y162; amount dollars/
 * cents f3_1/f3_2 (2025) / f4_2/f4_3 (2026) at y163; quarter checkboxes
 * c3_1[0..3] (2025) / c4_1[0..3] (2026); name f1_3 y138; street address
 * f3_3 / f4_5 y114; city-state-ZIP f3_4 / f4_6 y90.
 */

/** One split money box (IRS convention: dollars field + cents field). */
export interface MoneyField {
  dollars: string;
  cents: string;
}

export interface F941FieldMap {
  // Page 1 entity area
  einFirst2: string;
  einLast7: string;
  legalName: string;
  /** Trade name — left blank (none on file). */
  tradeName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Report-for-quarter checkboxes, Q1–Q4 in order. */
  quarterCheckboxes: readonly [string, string, string, string];

  // Part 1
  line1Employees: string;
  line2Wages: MoneyField;
  line3FederalWithheld: MoneyField;
  /** Line 4 — "no wages subject to SS/Medicare"; we never check it. */
  line4Checkbox: string;
  line5aWages: MoneyField;
  line5aTax: MoneyField;
  line5bTips: MoneyField;
  line5bTax: MoneyField;
  line5cWages: MoneyField;
  line5cTax: MoneyField;
  line5dWages: MoneyField;
  line5dTax: MoneyField;
  line5eTotal: MoneyField;
  line5f3121q: MoneyField;
  line6TotalTaxes: MoneyField;
  line7FractionsOfCents: MoneyField;
  line8SickPay: MoneyField;
  line9TipsGtl: MoneyField;
  line10TotalAfterAdjustments: MoneyField;
  line11ResearchCredit: MoneyField;
  line12TotalAfterCredits: MoneyField;
  line13Deposits: MoneyField;
  line14BalanceDue: MoneyField;
  line15Overpayment: MoneyField;
  overpaymentApplyToNext: string;
  overpaymentSendRefund: string;

  // Page 2 header + Part 2 (line 16)
  page2Name: string;
  page2EinFirst2: string;
  page2EinLast7: string;
  line16DeMinimis: string;
  line16Monthly: string;
  line16Semiweekly: string;
  line16Month1: MoneyField;
  line16Month2: MoneyField;
  line16Month3: MoneyField;
  line16Total: MoneyField;

  // Page 3 — Form 941-V payment voucher
  voucherEinFirst2: string;
  voucherEinLast7: string;
  voucherAmount: MoneyField;
  voucherQuarterCheckboxes: readonly [string, string, string, string];
  voucherName: string;
  voucherStreet: string;
  voucherCityStateZip: string;
}

const P1 = "topmostSubform[0].Page1[0]";
const P2 = "topmostSubform[0].Page2[0]";
const P3 = "topmostSubform[0].Page3[0]";

const money = (dollars: string, cents: string): MoneyField => ({ dollars, cents });

/**
 * The field map for a bundled revision year. Throws for years without a
 * bundled f941 template (mirrors templateBytes).
 */
export function f941FieldMap(year: 2025 | 2026): F941FieldMap {
  // Per-revision names: the 2026 revision renumbered the line-4 and line-15
  // checkboxes (it inserted the aggregate-filer checkboxes in the header and
  // the 15c–15e refund fields) and the voucher fields (f3_* → f4_*).
  const rev2025 = year === 2025;
  const v = (n2025: number, n2026: number) => `${P3}.${rev2025 ? `f3_${n2025}` : `f4_${n2026}`}[0]`;
  const vQuarter = (i: number) => `${P3}.Line3_ReadOrder[0].${rev2025 ? "c3_1" : "c4_1"}[${i}]`;

  return {
    einFirst2: `${P1}.Header[0].EntityArea[0].f1_1[0]`,
    einLast7: `${P1}.Header[0].EntityArea[0].f1_2[0]`,
    legalName: `${P1}.Header[0].EntityArea[0].f1_3[0]`,
    tradeName: `${P1}.Header[0].EntityArea[0].f1_4[0]`,
    street: `${P1}.Header[0].EntityArea[0].f1_5[0]`,
    city: `${P1}.Header[0].EntityArea[0].f1_6[0]`,
    state: `${P1}.Header[0].EntityArea[0].f1_7[0]`,
    zip: `${P1}.Header[0].EntityArea[0].f1_8[0]`,
    quarterCheckboxes: [
      `${P1}.Header[0].ReportForQuarter[0].c1_1[0]`,
      `${P1}.Header[0].ReportForQuarter[0].c1_1[1]`,
      `${P1}.Header[0].ReportForQuarter[0].c1_1[2]`,
      `${P1}.Header[0].ReportForQuarter[0].c1_1[3]`,
    ],

    line1Employees: `${P1}.f1_12[0]`,
    line2Wages: money(`${P1}.f1_13[0]`, `${P1}.f1_14[0]`),
    line3FederalWithheld: money(`${P1}.f1_15[0]`, `${P1}.f1_16[0]`),
    line4Checkbox: `${P1}.${rev2025 ? "c1_2" : "c1_3"}[0]`,
    line5aWages: money(`${P1}.f1_17[0]`, `${P1}.f1_18[0]`),
    line5aTax: money(`${P1}.f1_19[0]`, `${P1}.f1_20[0]`),
    line5bTips: money(`${P1}.f1_21[0]`, `${P1}.f1_22[0]`),
    line5bTax: money(`${P1}.f1_23[0]`, `${P1}.f1_24[0]`),
    line5cWages: money(`${P1}.f1_25[0]`, `${P1}.f1_26[0]`),
    line5cTax: money(`${P1}.f1_27[0]`, `${P1}.f1_28[0]`),
    line5dWages: money(`${P1}.f1_29[0]`, `${P1}.f1_30[0]`),
    line5dTax: money(`${P1}.f1_31[0]`, `${P1}.f1_32[0]`),
    line5eTotal: money(`${P1}.f1_33[0]`, `${P1}.f1_34[0]`),
    line5f3121q: money(`${P1}.f1_35[0]`, `${P1}.f1_36[0]`),
    line6TotalTaxes: money(`${P1}.f1_37[0]`, `${P1}.f1_38[0]`),
    line7FractionsOfCents: money(`${P1}.f1_39[0]`, `${P1}.f1_40[0]`),
    line8SickPay: money(`${P1}.f1_41[0]`, `${P1}.f1_42[0]`),
    line9TipsGtl: money(`${P1}.f1_43[0]`, `${P1}.f1_44[0]`),
    line10TotalAfterAdjustments: money(`${P1}.f1_45[0]`, `${P1}.f1_46[0]`),
    line11ResearchCredit: money(`${P1}.f1_47[0]`, `${P1}.f1_48[0]`),
    line12TotalAfterCredits: money(`${P1}.f1_49[0]`, `${P1}.f1_50[0]`),
    line13Deposits: money(`${P1}.f1_51[0]`, `${P1}.f1_52[0]`),
    line14BalanceDue: money(`${P1}.f1_53[0]`, `${P1}.f1_54[0]`),
    line15Overpayment: money(`${P1}.f1_55[0]`, `${P1}.f1_56[0]`),
    overpaymentApplyToNext: `${P1}.${rev2025 ? "c1_3" : "c1_4"}[0]`,
    overpaymentSendRefund: `${P1}.${rev2025 ? "c1_3" : "c1_4"}[1]`,

    page2Name: `${P2}.Name_ReadOrder[0].f1_3[0]`,
    page2EinFirst2: `${P2}.EIN_Number[0].f1_1[0]`,
    page2EinLast7: `${P2}.EIN_Number[0].f1_2[0]`,
    line16DeMinimis: `${P2}.c2_1[0]`,
    line16Monthly: `${P2}.c2_1[1]`,
    line16Semiweekly: `${P2}.c2_1[2]`,
    line16Month1: money(`${P2}.f2_1[0]`, `${P2}.f2_2[0]`),
    line16Month2: money(`${P2}.f2_3[0]`, `${P2}.f2_4[0]`),
    line16Month3: money(`${P2}.f2_5[0]`, `${P2}.f2_6[0]`),
    line16Total: money(`${P2}.f2_7[0]`, `${P2}.f2_8[0]`),

    voucherEinFirst2: `${P3}.EIN_Number[0].f1_1[0]`,
    voucherEinLast7: `${P3}.EIN_Number[0].f1_2[0]`,
    voucherAmount: money(v(1, 2), v(2, 3)),
    voucherQuarterCheckboxes: [vQuarter(0), vQuarter(1), vQuarter(2), vQuarter(3)],
    voucherName: `${P3}.f1_3[0]`,
    voucherStreet: v(3, 5),
    voucherCityStateZip: v(4, 6),
  };
}

/**
 * Metadata date pinned into every rendered PDF (creation + modification):
 * the template's revision date. Pinning makes the rendered bytes a pure
 * function of the template + filled figures, so identical worksheets render
 * byte-identical PDFs (the ticket's byte-stability rule) — render time is
 * deliberately not recorded.
 */
export const F941_REVISION_DATE: Record<number, string> = {
  2025: "2025-03-01T00:00:00Z",
  2026: "2026-03-01T00:00:00Z",
};
