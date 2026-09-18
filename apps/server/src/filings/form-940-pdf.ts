/**
 * PAY-33: assemble the filled-Form-940 PDF input for a tax filing — the
 * filing's frozen annual FUTA worksheet snapshot (figures provably match
 * the snapshot hash) plus the company header (EIN decrypted at render time
 * only). The PDF renders on demand and is never stored (payslip/W-2/941
 * doctrine). Ships unsigned — wet/e-sign after download (PAY-16 decision).
 */

import type { F940Input } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { employerBlock, type Worksheet940 } from "./annual.js";
import { getFilingDetail } from "./service.js";
import { FilingServiceError } from "./shared.js";

interface Deps {
  db: Db;
  config: AppConfig;
}

/**
 * The 940 PDF input for one filing row. Reading the detail refreshes the
 * worksheet while unfiled (so the PDF tracks the current figures); filed
 * rows render their frozen snapshot. Throws invalid_input for non-940
 * filings and invalid_transition when no worksheet exists yet.
 */
export async function f940PdfInputFor(deps: Deps, filingId: number): Promise<F940Input> {
  const { db, config } = deps;
  const { filing } = await getFilingDetail(db, filingId);
  if (filing.formType !== "940") {
    throw new FilingServiceError("invalid_input", `filing ${filingId} is not a Form 940 filing`);
  }
  if (!filing.worksheet) {
    throw new FilingServiceError(
      "invalid_transition",
      "no worksheet for this filing yet — the PDF unlocks once the year's worksheet exists",
    );
  }
  const w = filing.worksheet as Worksheet940;
  return {
    taxYear: filing.year,
    employer: await employerBlock(db, config),
    sutaCreditRate: w.sutaCreditRate,
    line3TotalPayments: w.line3TotalPayments,
    line7FutaTaxableWages: w.line7FutaTaxableWages,
    line12TotalFutaTax: w.line12TotalFutaTax,
    balanceDue: w.balanceDue,
  };
}
