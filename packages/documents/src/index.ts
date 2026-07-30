/**
 * Payslip PDF renderer (spec documents D5) — ported from
 * stack-finance/mcp-accounting/src/pdf/pdfmake-renderer.ts (paystub portion).
 *
 * Renders EXCLUSIVELY from the frozen run_snapshot: frozen inputs, computed
 * results, and display fields copied in at issuance. Live config is never
 * consulted. Output is an in-memory Buffer; nothing is stored.
 *
 * Employee-facing by design: employer-side costs (employer FICA/FUTA) are
 * intentionally NOT shown — they are not relevant to the employee (owner
 * decision 2026-07-30). They remain in the snapshot/DB for admin views.
 * The YTD block (template ≥1.1.0) shows gross, total withholdings, and net.
 *
 * No company logo: the original renderer fetched logo-black.png from
 * Nextcloud at runtime; no logo asset exists in the stack-finance repo, so
 * the payslip renders the company name as text (spec allows proceeding
 * without, noted in the step report).
 */

import type { PayrollResult } from "@payroll/engine";

// pdfmake 0.3.x — no TypeScript declarations, use the untyped import idiom
// from the original renderer.
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

pdfMake.fonts = RobotoFonts;

/** Snapshot subset the payslip renders from (structurally matches the server's RunSnapshot). */
export interface PayslipSnapshot {
  inputs: {
    periodAmount: number;
    frequency: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
  };
  result: PayrollResult;
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (template ≥1.1.0); pre-1.1.0 snapshots render gross-only. */
  ytd?: {
    gross: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: pdfmake content types are not installed; runtime accepts these shapes
type Content = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake cell types are not installed; runtime accepts these shapes
type TableCell = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake doc-definition types are not installed; runtime accepts these shapes
type DocDefinition = any;

type LayoutNode = { table: { body: unknown[] } };

const ACCENT_BLUE = "#1A3B6E";
const DARK_TEXT = "#000000";
const GRAY_LINE = "#D1D5DB";
const LIGHT_BG = "#F5F5F5";

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "April 2026" for monthly periods; "2026-04-01 → 2026-04-30" otherwise. */
function periodLabel(snapshot: PayslipSnapshot): string {
  const { periodStart, periodEnd } = snapshot.inputs;
  if (periodStart.slice(0, 7) === periodEnd.slice(0, 7)) {
    const [year, month] = periodStart.split("-");
    return `${MONTHS[Number(month) - 1]} ${year}`;
  }
  return `${periodStart} → ${periodEnd}`;
}

/** "2026-04-15" → "04/15/2026" (matches the legacy stub convention). */
function payDateLabel(payDate: string): string {
  const [year, month, day] = payDate.split("-");
  return `${month}/${day}/${year}`;
}

function buildPayslipDoc(snapshot: PayslipSnapshot): DocDefinition {
  const { inputs, result } = snapshot;
  const employeeName = inputs.employee.preferredName ?? inputs.employee.legalName;

  const deductions = [
    { label: "Federal Income Tax", amount: result.federalWithholding },
    { label: "Social Security", amount: result.socialSecurity },
    { label: "Medicare", amount: result.medicare },
    ...(result.stateWithholding > 0
      ? [{ label: "State Income Tax", amount: result.stateWithholding }]
      : []),
  ];
  const deductionRows: TableCell[][] = deductions.map((d) => [
    { text: d.label, fontSize: 9 },
    { text: `-${usd(d.amount)}`, fontSize: 9, alignment: "right" },
  ]);

  const content: Content[] = [
    // Header
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "PAY STUB", style: "title", color: DARK_TEXT },
            { text: inputs.company.legalName, bold: true, fontSize: 11, margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: `Pay Period: ${periodLabel(snapshot)}`, fontSize: 10, alignment: "right" },
            { text: `Pay Date: ${payDateLabel(inputs.payDate)}`, fontSize: 10, alignment: "right" },
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    // Employee
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            { text: "Employee", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: employeeName, fillColor: LIGHT_BG, margin: [4, 4, 4, 4], alignment: "right" },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 15],
    },

    // Earnings
    { text: "Earnings", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "Gross Pay", fontSize: 9, bold: true },
            { text: usd(result.grossPay), fontSize: 9, alignment: "right", bold: true },
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

    // Deductions
    { text: "Employee Deductions", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          ...deductionRows,
          [
            { text: "Total Deductions", fontSize: 9, bold: true },
            {
              text: `-${usd(result.totalDeductions)}`,
              fontSize: 9,
              alignment: "right",
              bold: true,
            },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number, node: LayoutNode) =>
          i === 0 || i === node.table.body.length ? 1 : 0,
        vLineWidth: () => 0,
        hLineColor: () => GRAY_LINE,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // Net pay banner
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            {
              text: "NET PAY",
              fontSize: 14,
              bold: true,
              color: "#FFFFFF",
              fillColor: ACCENT_BLUE,
              margin: [8, 8, 8, 8],
            },
            {
              text: usd(result.netPay),
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

    // YTD — employee-side totals through this run (template ≥1.1.0).
    // Pre-1.1.0 snapshots (never shipped) fall back to gross-only.
    {
      table: {
        widths: ["*", "auto"],
        body: (
          (snapshot.ytd
            ? [
                ["Year-to-Date Gross", usd(snapshot.ytd.gross)],
                ["Year-to-Date Withholdings", `-${usd(snapshot.ytd.totalDeductions)}`],
                ["Year-to-Date Net Pay", usd(snapshot.ytd.netPay)],
              ]
            : [["Year-to-Date Gross", usd(result.ytdGross)]]) as [string, string][]
        ).map(([label, value]) => [
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
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: {
      title: { fontSize: 18, bold: true, color: DARK_TEXT },
    },
    pageMargins: [40, 40, 40, 40],
    // Determinism breadcrumb: engine + template that produced this render.
    footer: (currentPage: number, pageCount: number) => ({
      text: `Generated from immutable run snapshot · engine ${snapshot.engineVersion} · template ${snapshot.templateVersion} · page ${currentPage}/${pageCount}`,
      fontSize: 7,
      color: "#9CA3AF",
      alignment: "center",
    }),
  };
}

/** Render a payslip PDF from a frozen run snapshot. Pure: same snapshot → same document. */
export async function renderPayslipPdf(snapshot: PayslipSnapshot): Promise<Buffer> {
  const doc = pdfMake.createPdf(buildPayslipDoc(snapshot));
  return doc.getBuffer();
}
