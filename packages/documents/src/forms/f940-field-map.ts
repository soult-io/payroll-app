/**
 * Field map for the bundled IRS Form 940 template (PAY-33) — built by
 * dumping every AcroForm widget's full name, page, and rect from the real
 * PDF (irs-pdf/f940.pdf, Form 940 for 2025) and matching each box by
 * position, then verified by filling a sample and re-reading the values
 * per field. One bundled revision (2025) so far; the 2026 form lands with
 * the year-end work.
 *
 * Rect-verified anchors (612×792 pt, y from bottom):
 *
 * Page 1 entity area — EIN f1_1 x151 w47 (2 digits) + f1_2 x217 w172 (7
 * digits) at y708; name f1_3 y684; trade name f1_4 y660; street f1_5 y636;
 * city f1_6 / state f1_7 / ZIP f1_8 at y600; foreign f1_9–f1_11 at y571.
 * Type-of-return checkboxes c1_1–c1_4 x425 (y688/673/658/637); aggregate
 * filer c1_5[0..2] (y578/563/548).
 *
 * Page 1 Parts 1–4 (money boxes are split dollars w92 + cents w21):
 * line 1a state f1_12/f1_13 y507 (single-char boxes); 1b multi-state c1_6
 * y488; 2 credit-reduction c1_7 y466; line 3 f1_14/15 y426; line 4
 * f1_16/17 y408 with exempt-type checkboxes 4a c1_8 / 4b c1_9 (x158),
 * 4c c1_10 / 4d c1_11 (x310), 4e c1_12 (x432); line 5 f1_18/19 y354;
 * line 6 f1_20/21 y336; line 7 f1_22/23 y315; line 8 f1_24/25 y294;
 * line 9 f1_26/27 y255; line 10 f1_28/29 y225; line 11 f1_30/31 y204;
 * line 12 f1_32/33 y168; line 13 f1_34/35 y147; line 14 f1_36/37 y108;
 * line 15a f1_48/49 y84 with the 15b election c1_2[0]/c1_2[1]; 15c–15e
 * direct-deposit refund fields (RoutingNo f1_40, type c1_14[0..1],
 * AccountNo f1_41) left blank.
 *
 * Page 2 — header name f1_3 + EIN f1_1/f1_2 at y720. Part 5 quarterly
 * liability 16a f2_1/2 (y654), 16b f2_3/4 (y630), 16c f2_5/6 (y606), 16d
 * f2_7/8 (y582), 17 total f2_9/10 (y558) — LEFT BLANK: required only when
 * line 12 > $500 and the worksheet does not carry per-quarter liability.
 * Part 6 designee c2_1[0..1] + f2_11–f2_13 blank. Part 7 print-name/title/
 * phone f2_14–f2_16 blank (wet signature — the signature/date boxes are
 * not AcroForm fields). Paid preparer c2_2[0] + f2_17–f2_25 blank.
 *
 * Page 3 (Form 940-V voucher) — EIN f1_1/f1_2 at y150; amount f3_1/f3_2
 * y151; name f1_3 y126; street f3_4 y102; city-state-ZIP f3_5 y78.
 */

import type { MoneyField } from "./f941-field-map.js";

export interface F940FieldMap {
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

  // Part 1 — state/credit-reduction questions (worksheet carries no state)
  line1aStateFirst: string;
  line1aStateSecond: string;
  line1bMultiState: string;
  line2CreditReduction: string;

  // Part 2 — FUTA tax before adjustments
  line3TotalPayments: MoneyField;
  line4ExemptPayments: MoneyField;
  line5ExcessWages: MoneyField;
  line6Subtotal: MoneyField;
  line7FutaTaxableWages: MoneyField;
  line8FutaTax: MoneyField;

  // Part 3 — adjustments
  line9AllExcludedFromSuta: MoneyField;
  line10SomeExcludedOrLateSuta: MoneyField;
  line11CreditReduction: MoneyField;

  // Part 4 — balance due / overpayment
  line12TotalFutaTax: MoneyField;
  line13Deposited: MoneyField;
  line14BalanceDue: MoneyField;
  line15aOverpayment: MoneyField;
  overpaymentApplyToNext: string;
  overpaymentSendRefund: string;

  // Page 2 header + Part 5 (quarterly liability — left blank)
  page2Name: string;
  page2EinFirst2: string;
  page2EinLast7: string;
  line16aQ1: MoneyField;
  line16bQ2: MoneyField;
  line16cQ3: MoneyField;
  line16dQ4: MoneyField;
  line17TotalLiability: MoneyField;

  // Page 3 — Form 940-V payment voucher
  voucherEinFirst2: string;
  voucherEinLast7: string;
  voucherAmount: MoneyField;
  voucherName: string;
  voucherStreet: string;
  voucherCityStateZip: string;
}

const P1 = "topmostSubform[0].Page1[0]";
const P2 = "topmostSubform[0].Page2[0]";
const P3 = "topmostSubform[0].Page3[0]";

const money = (dollars: string, cents: string): MoneyField => ({ dollars, cents });

/** The field map for the bundled 2025 revision. */
export const F940_FIELD_MAP: F940FieldMap = {
  einFirst2: `${P1}.EntityArea[0].f1_1[0]`,
  einLast7: `${P1}.EntityArea[0].f1_2[0]`,
  legalName: `${P1}.EntityArea[0].f1_3[0]`,
  tradeName: `${P1}.EntityArea[0].f1_4[0]`,
  street: `${P1}.EntityArea[0].f1_5[0]`,
  city: `${P1}.EntityArea[0].f1_6[0]`,
  state: `${P1}.EntityArea[0].f1_7[0]`,
  zip: `${P1}.EntityArea[0].f1_8[0]`,

  line1aStateFirst: `${P1}.f1_12[0]`,
  line1aStateSecond: `${P1}.f1_13[0]`,
  line1bMultiState: `${P1}.c1_6[0]`,
  line2CreditReduction: `${P1}.c1_7[0]`,

  line3TotalPayments: money(`${P1}.f1_14[0]`, `${P1}.f1_15[0]`),
  line4ExemptPayments: money(`${P1}.f1_16[0]`, `${P1}.f1_17[0]`),
  line5ExcessWages: money(`${P1}.f1_18[0]`, `${P1}.f1_19[0]`),
  line6Subtotal: money(`${P1}.f1_20[0]`, `${P1}.f1_21[0]`),
  line7FutaTaxableWages: money(`${P1}.f1_22[0]`, `${P1}.f1_23[0]`),
  line8FutaTax: money(`${P1}.f1_24[0]`, `${P1}.f1_25[0]`),

  line9AllExcludedFromSuta: money(`${P1}.f1_26[0]`, `${P1}.f1_27[0]`),
  line10SomeExcludedOrLateSuta: money(`${P1}.f1_28[0]`, `${P1}.f1_29[0]`),
  line11CreditReduction: money(`${P1}.f1_30[0]`, `${P1}.f1_31[0]`),

  line12TotalFutaTax: money(`${P1}.f1_32[0]`, `${P1}.f1_33[0]`),
  line13Deposited: money(`${P1}.f1_34[0]`, `${P1}.f1_35[0]`),
  line14BalanceDue: money(`${P1}.f1_36[0]`, `${P1}.f1_37[0]`),
  line15aOverpayment: money(`${P1}.f1_48[0]`, `${P1}.f1_49[0]`),
  overpaymentApplyToNext: `${P1}.c1_2[0]`,
  overpaymentSendRefund: `${P1}.c1_2[1]`,

  page2Name: `${P2}.f1_3[0]`,
  page2EinFirst2: `${P2}.f1_1[0]`,
  page2EinLast7: `${P2}.f1_2[0]`,
  line16aQ1: money(`${P2}.f2_1[0]`, `${P2}.f2_2[0]`),
  line16bQ2: money(`${P2}.f2_3[0]`, `${P2}.f2_4[0]`),
  line16cQ3: money(`${P2}.f2_5[0]`, `${P2}.f2_6[0]`),
  line16dQ4: money(`${P2}.f2_7[0]`, `${P2}.f2_8[0]`),
  line17TotalLiability: money(`${P2}.f2_9[0]`, `${P2}.f2_10[0]`),

  voucherEinFirst2: `${P3}.Line1ReadOrder[0].f1_1[0]`,
  voucherEinLast7: `${P3}.Line1ReadOrder[0].f1_2[0]`,
  voucherAmount: money(`${P3}.f3_1[0]`, `${P3}.f3_2[0]`),
  voucherName: `${P3}.f1_3[0]`,
  voucherStreet: `${P3}.f3_4[0]`,
  voucherCityStateZip: `${P3}.f3_5[0]`,
};

/**
 * Metadata date pinned into every rendered PDF (creation + modification):
 * the template's revision year. Pinning makes the rendered bytes a pure
 * function of the template + filled figures, so identical worksheets render
 * byte-identical PDFs — render time is deliberately not recorded.
 */
export const F940_REVISION_DATE: Record<number, string> = {
  2025: "2025-01-01T00:00:00Z",
};
