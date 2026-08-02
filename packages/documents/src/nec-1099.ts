/**
 * 1099-NEC recipient-statement renderer (spec 10 §3) — generated ON DEMAND
 * from stored contractor_payments (deterministic, generated-not-stored — the
 * same doctrine as payslips, D5). This is a SUBSTITUTE recipient statement
 * for review/records, not scannable IRS Copy A; transmission (IRIS/FIRE)
 * stays a manual/Accountant step (spec 10 §7).
 *
 * Box 1 = reportable nonemployee compensation (payments whose method is NOT
 * card/third_party_network — those are the processor's 1099-K); box 4 = total
 * backup withholding (24% when contractor_details.backup_withholding). Payer
 * fields come from the company row (legal_name, decrypted ein, address).
 */

import { round2 } from "@payroll/engine/money";

// pdfmake 0.3.x — no TypeScript declarations, same untyped import idiom as
// the payslip renderer.
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

pdfMake.fonts = RobotoFonts;

export interface Nec1099Address {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** Everything the form renders from — assembled server-side from stored rows. */
export interface Nec1099Input {
  taxYear: number;
  payer: {
    legalName: string;
    /** Decrypted EIN, or null when not yet configured. */
    ein: string | null;
    address: Nec1099Address | null;
  };
  recipient: { legalName: string };
  /** Box 1 — reportable nonemployee compensation for the tax year. */
  box1: number;
  /** Box 4 — federal backup withholding for the tax year. */
  box4: number;
  /** The dated threshold that required this form (auditability breadcrumb). */
  threshold: number;
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
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function addressLines(address: Nec1099Address | null): string[] {
  if (!address) return [];
  return [
    address.line1,
    ...(address.line2 ? [address.line2] : []),
    `${address.city}, ${address.state} ${address.zip}`,
    address.country,
  ];
}

function partyBlock(title: string, lines: string[]): Content {
  return {
    stack: [
      { text: title, bold: true, fontSize: 9, color: ACCENT_BLUE, margin: [0, 0, 0, 2] },
      ...lines.map((line) => ({ text: line, fontSize: 9 })),
    ],
    margin: [0, 0, 0, 12],
  };
}

function buildNec1099Doc(input: Nec1099Input): DocDefinition {
  const content: Content[] = [
    // Header
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "1099-NEC", style: "title" },
            { text: "Nonemployee Compensation", fontSize: 11, margin: [0, 2, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: `Tax Year ${input.taxYear}`, fontSize: 10, alignment: "right" },
            {
              text: "Substitute recipient statement",
              fontSize: 8,
              color: "#6B7280",
              alignment: "right",
            },
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    partyBlock("PAYER", [
      input.payer.legalName,
      ...addressLines(input.payer.address),
      `EIN: ${input.payer.ein ?? "not configured"}`,
    ]),

    partyBlock("RECIPIENT", [input.recipient.legalName]),

    // Boxes
    {
      table: {
        widths: ["auto", "*", "auto"],
        body: [
          [
            { text: "Box", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: "Description", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            {
              text: "Amount",
              bold: true,
              fillColor: LIGHT_BG,
              margin: [4, 4, 4, 4],
              alignment: "right",
            },
          ],
          [
            { text: "1", margin: [4, 4, 4, 4] },
            { text: "Nonemployee compensation", margin: [4, 4, 4, 4] },
            { text: usd(input.box1), margin: [4, 4, 4, 4], alignment: "right" },
          ],
          [
            { text: "4", margin: [4, 4, 4, 4] },
            { text: "Federal income tax withheld (backup withholding)", margin: [4, 4, 4, 4] },
            { text: usd(input.box4), margin: [4, 4, 4, 4], alignment: "right" },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i <= 1 ? 1 : 0),
        vLineWidth: () => 0,
        hLineColor: () => GRAY_LINE,
      },
      margin: [0, 0, 0, 20],
    },

    {
      text: [
        { text: "Notes: ", bold: true },
        {
          text:
            "Generated from recorded payments. Payments made by card or third-party " +
            "payment network are excluded from box 1 (the processor reports them on " +
            "Form 1099-K). This is a substitute recipient statement for review and " +
            "records — verify against the official IRS form before filing; IRIS/FIRE " +
            "transmission is a separate manual step.",
        },
      ],
      fontSize: 8,
      color: "#6B7280",
    },
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: { title: { fontSize: 18, bold: true, color: DARK_TEXT } },
    pageMargins: [40, 40, 40, 40],
    footer: (currentPage: number, pageCount: number) => ({
      text: `Generated on demand from stored contractor payments · tax year ${input.taxYear} · reporting threshold ${usd(input.threshold)} · page ${currentPage}/${pageCount}`,
      fontSize: 7,
      color: "#9CA3AF",
      alignment: "center",
    }),
  };
}

/** Render a 1099-NEC substitute statement PDF. Pure: same input → same document. */
export async function renderNec1099Pdf(input: Nec1099Input): Promise<Buffer> {
  const normalized: Nec1099Input = {
    ...input,
    box1: round2(input.box1),
    box4: round2(input.box4),
  };
  const doc = pdfMake.createPdf(buildNec1099Doc(normalized));
  return doc.getBuffer();
}
