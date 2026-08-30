/**
 * W-2 / W-3 renderers (PAY-11) — generated ON DEMAND from figures assembled
 * server-side from frozen issued-run payroll_entries (generated-not-stored,
 * the same doctrine as payslips and the 1099-NEC, D5). These are substitute
 * statements for review/records and employee distribution, not scannable
 * Copy A — actual transmission (SSA BSO for W-2/W-3) stays a manual step.
 *
 * Unlike payslip emails, the W-2 PDF is the official document: it carries
 * FULL figures plus PII (employee SSN + address, company EIN). The server
 * decrypts PII at render time only; nothing here persists or logs it.
 * buildW2Doc/buildW3Doc are exported separately from the renderers so tests
 * can assert document CONTENT (PII + full figures) without parsing PDF bytes.
 */

import type { Buffer } from "node:buffer";

// pdfmake 0.3.x — no TypeScript declarations, same untyped import idiom as
// the payslip and 1099-NEC renderers.
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

pdfMake.fonts = RobotoFonts;

export interface FormAddress {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** Everything a W-2 renders from — assembled server-side from stored rows. */
export interface W2Input {
  taxYear: number;
  employer: {
    legalName: string;
    /** Decrypted EIN, or null when not yet configured. */
    ein: string | null;
    address: FormAddress | null;
  };
  employee: {
    legalName: string;
    /** Decrypted SSN, formatted ###-##-####; null when not yet on file. */
    ssn: string | null;
    address: FormAddress | null;
  };
  /** Box 1 — wages, tips, other compensation. */
  box1Wages: number;
  /** Box 2 — federal income tax withheld. */
  box2FederalWithheld: number;
  /** Box 3 — Social Security wages (capped). */
  box3SsWages: number;
  /** Box 4 — Social Security tax withheld (employee share). */
  box4SsTax: number;
  /** Box 5 — Medicare wages and tips (no cap). */
  box5MedicareWages: number;
  /** Box 6 — Medicare tax withheld (employee share). */
  box6MedicareTax: number;
}

/** W-3 transmittal — the box-by-box aggregate across all W-2s of the year. */
export interface W3Input {
  taxYear: number;
  employer: W2Input["employer"];
  /** Number of W-2 statements summarized. */
  employeeCount: number;
  box1Wages: number;
  box2FederalWithheld: number;
  box3SsWages: number;
  box4SsTax: number;
  box5MedicareWages: number;
  box6MedicareTax: number;
}

// biome-ignore lint/suspicious/noExplicitAny: pdfmake content types are not installed; runtime accepts these shapes
type Content = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake doc-definition types are not installed; runtime accepts these shapes
type DocDefinition = any;

const ACCENT_BLUE = "#1A3B6E";
const DARK_TEXT = "#000000";
const GRAY_LINE = "#D1D5DB";
const LIGHT_BG = "#F5F5F5";

function usd(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addressLines(address: FormAddress | null): string {
  if (!address) return "—";
  const line2 = address.line2 ? `${address.line2}\n` : "";
  return `${address.line1}\n${line2}${address.city}, ${address.state} ${address.zip}\n${address.country}`;
}

function partyBlock(label: string, lines: string[]): Content {
  return {
    table: {
      widths: ["*"],
      body: [
        [{ text: label, bold: true, fillColor: LIGHT_BG, fontSize: 9, margin: [4, 3, 4, 3] }],
        [{ text: lines.join("\n"), fontSize: 9, margin: [4, 3, 4, 3] }],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => GRAY_LINE,
      vLineColor: () => GRAY_LINE,
    },
  };
}

/** One labeled box row, e.g. "1  Wages, tips, other compensation | 48,000.00". */
function boxRow(box: string, label: string, amount: number): Content[] {
  return [
    { text: box, fontSize: 9, bold: true, margin: [4, 3, 4, 3] },
    { text: label, fontSize: 9, margin: [4, 3, 4, 3] },
    { text: usd(amount), fontSize: 9, alignment: "right", margin: [4, 3, 4, 3] },
  ];
}

function boxesTable(rows: [string, string, number][]): Content {
  return {
    table: {
      widths: ["auto", "*", "auto"],
      body: rows.map(([box, label, amount]) => boxRow(box, label, amount)),
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => GRAY_LINE,
      vLineColor: () => GRAY_LINE,
    },
    margin: [0, 0, 0, 12],
  };
}

function header(formTitle: string, taxYear: number, companyName: string): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: formTitle, style: "title", color: DARK_TEXT },
          { text: companyName, bold: true, fontSize: 11, margin: [0, 4, 0, 0] },
        ],
      },
      {
        width: "auto",
        stack: [
          { text: `Tax Year: ${taxYear}`, fontSize: 10, alignment: "right" },
          {
            text: "Copy B — for employee records",
            fontSize: 8,
            alignment: "right",
            color: ACCENT_BLUE,
          },
        ],
      },
    ],
    margin: [0, 0, 0, 16],
  };
}

const SUBSTITUTE_NOTE =
  "Substitute statement generated from frozen payroll records — for records and review. " +
  "Official transmission to the SSA/IRS is a separate step (see the app's e-file help).";

export function buildW2Doc(input: W2Input): DocDefinition {
  const content: Content[] = [
    header("FORM W-2 — Wage and Tax Statement", input.taxYear, input.employer.legalName),
    {
      columns: [
        {
          width: "*",
          stack: [
            partyBlock("Employer", [
              input.employer.legalName,
              `EIN: ${input.employer.ein ?? "—"}`,
              addressLines(input.employer.address),
            ]),
          ],
        },
        {
          width: "*",
          stack: [
            partyBlock("Employee", [
              input.employee.legalName,
              `SSN: ${input.employee.ssn ?? "—"}`,
              addressLines(input.employee.address),
            ]),
          ],
        },
      ],
      columnGap: 12,
      margin: [0, 0, 0, 12],
    },
    boxesTable([
      ["1", "Wages, tips, other compensation", input.box1Wages],
      ["2", "Federal income tax withheld", input.box2FederalWithheld],
      ["3", "Social Security wages", input.box3SsWages],
      ["4", "Social Security tax withheld", input.box4SsTax],
      ["5", "Medicare wages and tips", input.box5MedicareWages],
      ["6", "Medicare tax withheld", input.box6MedicareTax],
    ]),
    { text: SUBSTITUTE_NOTE, fontSize: 8, color: ACCENT_BLUE },
  ];
  return {
    content,
    styles: { title: { fontSize: 15, bold: true } },
    defaultStyle: { font: "Roboto" },
  };
}

export function buildW3Doc(input: W3Input): DocDefinition {
  const content: Content[] = [
    header(
      "FORM W-3 — Transmittal of Wage and Tax Statements",
      input.taxYear,
      input.employer.legalName,
    ),
    partyBlock("Employer", [
      input.employer.legalName,
      `EIN: ${input.employer.ein ?? "—"}`,
      addressLines(input.employer.address),
    ]),
    {
      text: `Number of W-2 statements: ${input.employeeCount}`,
      fontSize: 10,
      bold: true,
      margin: [0, 12, 0, 8],
    },
    boxesTable([
      ["1", "Wages, tips, other compensation", input.box1Wages],
      ["2", "Federal income tax withheld", input.box2FederalWithheld],
      ["3", "Social Security wages", input.box3SsWages],
      ["4", "Social Security tax withheld", input.box4SsTax],
      ["5", "Medicare wages and tips", input.box5MedicareWages],
      ["6", "Medicare tax withheld", input.box6MedicareTax],
    ]),
    { text: SUBSTITUTE_NOTE, fontSize: 8, color: ACCENT_BLUE },
  ];
  return {
    content,
    styles: { title: { fontSize: 15, bold: true } },
    defaultStyle: { font: "Roboto" },
  };
}

/** Render a W-2 PDF. Pure: same input → same document. */
export async function renderW2Pdf(input: W2Input): Promise<Buffer> {
  const doc = pdfMake.createPdf(buildW2Doc(input));
  return doc.getBuffer();
}

/** Render a W-3 transmittal PDF. Pure: same input → same document. */
export async function renderW3Pdf(input: W3Input): Promise<Buffer> {
  const doc = pdfMake.createPdf(buildW3Doc(input));
  return doc.getBuffer();
}
