/**
 * Contractor invoice PDF renderer (PAY-7) — generated ON DEMAND from the
 * stored contractor_invoices + contractor_payments rows (generated-not-stored,
 * the same doctrine as payslips, D5). Employee-facing: the contractor's own
 * invoice and its settlement. No employer-side data exists on an invoice, so
 * there is nothing to withhold from the render.
 *
 * Deterministic: same rows → same document; no render date, no live config.
 */

import type { Buffer } from "node:buffer";

// pdfmake 0.3.x — no TypeScript declarations, same untyped import idiom as
// the payslip renderer. Font assignment is module state and idempotent.
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

pdfMake.fonts = RobotoFonts;

export interface InvoicePdfInput {
  company: { legalName: string };
  contractor: { legalName: string; preferredName: string | null };
  /** YYYY-MM-DD. */
  invoiceDate: string;
  description: string;
  /** Decimal string from the DB ("2000.00"). */
  amount: string;
  currency: string;
  status: "approved" | "paid";
  payment: {
    payDate: string;
    amount: string;
    method: string;
    reference: string | null;
    backupWithheld: string;
  } | null;
}

// biome-ignore lint/suspicious/noExplicitAny: pdfmake content types are not installed; runtime accepts these shapes
type Content = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake doc-definition types are not installed; runtime accepts these shapes
type DocDefinition = any;

const ACCENT_BLUE = "#1A3B6E";
const DARK_TEXT = "#000000";
const GRAY_LINE = "#D1D5DB";
const LIGHT_BG = "#F5F5F5";

const METHOD_LABELS: Record<string, string> = {
  ach: "ACH transfer",
  check: "Check",
  wire: "Wire transfer",
  card: "Card",
  third_party_network: "Third-party network",
};

function amountLabel(amount: string, currency: string): string {
  const formatted = Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
}

/** "2026-08-31" → "08/31/2026" (matches the payslip date convention). */
function dateLabel(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function buildInvoiceDoc(input: InvoicePdfInput): DocDefinition {
  const contractorName = input.contractor.preferredName ?? input.contractor.legalName;
  const statusLabel = input.status === "paid" ? "PAID" : "APPROVED";
  const payment = input.payment;
  const backupWithheld = payment ? Number(payment.backupWithheld) : 0;

  const paymentRows: [string, string][] = payment
    ? [
        ["Pay date", dateLabel(payment.payDate)],
        ["Method", METHOD_LABELS[payment.method] ?? payment.method],
        ...(payment.reference ? [["Reference", payment.reference] as [string, string]] : []),
        ["Amount paid", amountLabel(payment.amount, input.currency)],
        ...(backupWithheld > 0
          ? ([
              [
                "Backup withholding (24%)",
                `-${amountLabel(payment.backupWithheld, input.currency)}`,
              ],
              [
                "Net received",
                amountLabel((Number(payment.amount) - backupWithheld).toFixed(2), input.currency),
              ],
            ] as [string, string][])
          : []),
      ]
    : [];

  const content: Content[] = [
    // Header
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "INVOICE", style: "title", color: DARK_TEXT },
            { text: input.company.legalName, bold: true, fontSize: 11, margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            {
              text: `Invoice date: ${dateLabel(input.invoiceDate)}`,
              fontSize: 10,
              alignment: "right",
            },
            {
              text: statusLabel,
              fontSize: 10,
              bold: true,
              alignment: "right",
              color: input.status === "paid" ? "#166534" : ACCENT_BLUE,
              margin: [0, 4, 0, 0],
            },
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    // Contractor
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            { text: "Contractor", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: contractorName, fillColor: LIGHT_BG, margin: [4, 4, 4, 4], alignment: "right" },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 15],
    },

    // Line item
    { text: "Services", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: input.description, fontSize: 9 },
            {
              text: amountLabel(input.amount, input.currency),
              fontSize: 9,
              alignment: "right",
              bold: true,
            },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 ? 1 : 0),
        vLineWidth: () => 0,
        hLineColor: () => GRAY_LINE,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // Total banner
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            {
              text: "TOTAL",
              fontSize: 14,
              bold: true,
              color: "#FFFFFF",
              fillColor: ACCENT_BLUE,
              margin: [8, 8, 8, 8],
            },
            {
              text: amountLabel(input.amount, input.currency),
              fontSize: 14,
              bold: true,
              alignment: "right",
              color: "#FFFFFF",
              fillColor: ACCENT_BLUE,
              margin: [8, 8, 8, 8],
            },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 20],
    },

    // Payment details (only once paid)
    ...(payment
      ? [
          { text: "Payment", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
          {
            table: {
              widths: ["*", "auto"],
              body: paymentRows.map(([label, value]) => [
                {
                  text: label,
                  fontSize: 10,
                  bold: true,
                  fillColor: LIGHT_BG,
                  margin: [4, 4, 4, 4],
                },
                {
                  text: value,
                  fontSize: 10,
                  alignment: "right",
                  fillColor: LIGHT_BG,
                  margin: [4, 4, 4, 4],
                },
              ]),
            },
            layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
          },
        ]
      : []),
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: {
      title: { fontSize: 18, bold: true, color: DARK_TEXT },
    },
    pageMargins: [40, 40, 40, 40],
    footer: (currentPage: number, pageCount: number) => ({
      text: `Generated on demand from the payroll system of record · page ${currentPage}/${pageCount}`,
      fontSize: 7,
      color: "#9CA3AF",
      alignment: "center",
    }),
  };
}

/** Render an invoice PDF from the stored invoice + payment rows. Pure: same input → same document. */
export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = pdfMake.createPdf(buildInvoiceDoc(input));
  return doc.getBuffer();
}
