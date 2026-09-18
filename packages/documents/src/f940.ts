/**
 * Official IRS Form 940 renderer (PAY-33): fill the bundled AcroForm
 * template (assets/forms/<year>/f940.pdf, checksummed — D2) with the frozen
 * annual FUTA worksheet snapshot, then FLATTEN so the download is a
 * finished document, not an editable form. Rendered on demand, never
 * stored — same doctrine as payslips, W-2/W-3, and the 941 (PAY-16).
 *
 * Figures come straight from the stored Worksheet940 JSON (strings, no
 * float round-trip), so the PDF provably matches the worksheet behind the
 * filing's snapshot hash. Creation/modification metadata is pinned to the
 * template's revision year: identical worksheets render byte-identical
 * PDFs.
 *
 * Form-vs-worksheet mapping note: the official form's line 8 is DEFINED as
 * line 7 × 0.006 — the SUTA-credit delta always surfaces in Part 3:
 *   - full 5.4% credit        → no adjustment lines (worksheet line 8 is
 *                               already the 0.6% figure);
 *   - no SUTA paid (0 credit) → line 9 = line 7 × 0.054 ("ALL taxable FUTA
 *                               wages excluded from state unemployment
 *                               tax" — the SOULT IO shape);
 *   - partial credit          → line 10 = worksheet line 12 − form line 8
 *                               ("SOME wages excluded / SUTA paid late").
 * Line 12 always equals the worksheet's line12TotalFutaTax. Line 5/6 are
 * derived (line 3 − line 7; no exempt payments tracked), line 13 = line
 * 12 − balance due (no FUTA deposits tracked in-app → 0.00).
 *
 * Signature journey (PAY-16 decision, unchanged): the PDF ships UNSIGNED —
 * signature/date/Part 7 print-name boxes stay blank for wet signature (or
 * e-sign after download) before the Letterstream mail upload. The
 * line-15b overpayment election is likewise left for signing time. Part 5
 * (quarterly liability) stays blank: it is required only when line 12
 * exceeds $500 and the worksheet does not carry per-quarter liability.
 *
 * prepareF940 returns the filled document BEFORE flattening so tests can
 * assert field placement; renderF940Pdf flattens and serializes.
 */

import { Buffer } from "node:buffer";
import { PDFDocument } from "pdf-lib";
import { round2 } from "@payroll/engine/money";
import { templateBytes } from "./forms/templates.js";
import { F940_FIELD_MAP, F940_REVISION_DATE } from "./forms/f940-field-map.js";
import { fillEin, fillMoney, fillText } from "./f941.js";
import type { FormAddress } from "./w2.js";

/** Everything a filled Form 940 renders from — the frozen worksheet + company. */
export interface F940Input {
  taxYear: number;
  employer: {
    legalName: string;
    /** EIN on file ("##-#######" or 9 plain digits), or null when unset. */
    ein: string | null;
    address: FormAddress | null;
  };
  /** SUTA credit rate assumed by the worksheet ("0.054" / "0" / partial). */
  sutaCreditRate: string;
  /** Worksheet figures, exactly as stored (money as "1234.56" strings). */
  line3TotalPayments: string;
  line7FutaTaxableWages: string;
  line12TotalFutaTax: string;
  balanceDue: string;
}

const FULL_SUTA_CREDIT = 0.054;

/**
 * Fill the template — NOT flattened (tests read the field values back).
 * Page 3 is the Form 940-V payment voucher: filled only when there is a
 * balance due; its boxes stay blank otherwise (a blank voucher page keeps
 * the download a constant 3 pages).
 */
export async function prepareF940(input: F940Input): Promise<PDFDocument> {
  const map = F940_FIELD_MAP;
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "f940"));
  const form = doc.getForm();
  const { employer } = input;

  // Entity area (Part 1's state questions stay blank — the worksheet
  // carries no state; reviewed at signing time).
  fillEin(form, map.einFirst2, map.einLast7, employer.ein);
  fillText(form, map.legalName, employer.legalName);
  const street = [employer.address?.line1, employer.address?.line2].filter(Boolean).join(" ");
  fillText(form, map.street, street || null);
  fillText(form, map.city, employer.address?.city ?? null);
  fillText(form, map.state, employer.address?.state ?? null);
  fillText(form, map.zip, employer.address?.zip ?? null);

  // Part 2 — line 8 is line 7 × 0.006 BY THE FORM'S DEFINITION; the SUTA
  // credit delta is always a Part 3 adjustment (see module doc).
  const line3 = Number(input.line3TotalPayments);
  const line7 = Number(input.line7FutaTaxableWages);
  const line12 = Number(input.line12TotalFutaTax);
  const line5 = round2(line3 - line7); // no exempt payments tracked (line 4 blank)
  const formLine8 = round2(line7 * 0.006);
  fillMoney(form, map.line3TotalPayments, input.line3TotalPayments);
  fillMoney(form, map.line5ExcessWages, line5.toFixed(2));
  fillMoney(form, map.line6Subtotal, line5.toFixed(2)); // line 4 + line 5
  fillMoney(form, map.line7FutaTaxableWages, input.line7FutaTaxableWages);
  fillMoney(form, map.line8FutaTax, formLine8.toFixed(2));

  // Part 3 — the SUTA-credit delta, per the worksheet's rate assumption.
  const credit = Number(input.sutaCreditRate);
  if (credit === 0) {
    fillMoney(form, map.line9AllExcludedFromSuta, round2(line7 * FULL_SUTA_CREDIT).toFixed(2));
  } else if (Math.abs(credit - FULL_SUTA_CREDIT) > 1e-9) {
    fillMoney(form, map.line10SomeExcludedOrLateSuta, round2(line12 - formLine8).toFixed(2));
  }

  // Part 4 — totals; line 13 is line 12 − balance due (no FUTA deposits
  // tracked in-app → 0.00), line 15a stays blank (no overpayment).
  fillMoney(form, map.line12TotalFutaTax, input.line12TotalFutaTax);
  fillMoney(form, map.line13Deposited, round2(line12 - Number(input.balanceDue)).toFixed(2));
  fillMoney(form, map.line14BalanceDue, input.balanceDue);

  // Page 2 — header. Part 5 (quarterly liability) stays blank: required
  // only when line 12 > $500 and not carried by the worksheet.
  fillText(form, map.page2Name, employer.legalName);
  fillEin(form, map.page2EinFirst2, map.page2EinLast7, employer.ein);

  // Page 3 — Form 940-V payment voucher, only when a balance is due.
  if (Number(input.balanceDue) > 0) {
    fillEin(form, map.voucherEinFirst2, map.voucherEinLast7, employer.ein);
    fillMoney(form, map.voucherAmount, input.balanceDue);
    fillText(form, map.voucherName, employer.legalName);
    fillText(form, map.voucherStreet, street || null);
    const cityStateZip = employer.address
      ? `${employer.address.city}, ${employer.address.state} ${employer.address.zip}`
      : null;
    fillText(form, map.voucherCityStateZip, cityStateZip);
  }

  return doc;
}

/** Filled official Form 940 (+ 940-V voucher page) — flattened, 3 pages. */
export async function renderF940Pdf(input: F940Input): Promise<Buffer> {
  const doc = await prepareF940(input);
  doc.getForm().flatten();
  // Pin metadata to the template revision: identical worksheets render
  // byte-identical PDFs (render time deliberately not recorded).
  const revision = new Date(
    F940_REVISION_DATE[input.taxYear] ?? `${input.taxYear}-01-01T00:00:00Z`,
  );
  doc.setCreationDate(revision);
  doc.setModificationDate(revision);
  return Buffer.from(await doc.save());
}
