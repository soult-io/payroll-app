/**
 * QA synthetic dataset (spec 14 §2) — persona coverage, engine-exact figures,
 * and re-run idempotency. Fixed `today` (2026-08-20) so the dataset is fully
 * deterministic: history = 2025-01..2026-07 (19 months × 3 employees = 57
 * issued runs) + one 2026-08 draft awaiting approval.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import {
  authTwoFactor,
  authUser,
  changeRequestComments,
  changeRequests,
  compensation,
  contractorDetails,
  contractorInvoices,
  contractorRecurringInvoices,
  employees,
  payrollEntries,
  payrollRuns,
  w4Elections,
} from "@payroll/db";
import {
  historyMonths,
  QA_ADMIN,
  QA_CHANGE_REQUEST_ADDRESS,
  QA_EMPLOYEE_LOGIN,
  seedQaDataset,
  type QaSeedSummary,
} from "../src/qa/seed-qa.js";
import { paymentDueSweep } from "../src/contractors/recurring.js";
import { decryptAddress } from "../src/crypto/address-encryption.js";
import { yearEndSummary } from "../src/contractors/service.js";
import { resolveW4 } from "../src/payroll/resolve.js";
import { createTestApp, type TestContext } from "./helpers.js";

const TODAY = "2026-08-20";

/** Non-null or throw — keeps test code free of `!` assertions. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
/** 2025 full year + 2026 through July. */
const EXPECTED_MONTHS = 19;
const ENTRY_FIELDS = [
  ["gross_pay", "grossPay"],
  ["federal_withholding", "federalWithholding"],
  ["social_security", "socialSecurity"],
  ["medicare", "medicare"],
  ["state_withholding", "stateWithholding"],
  ["net_pay", "netPay"],
  ["employer_social_security", "employerSocialSecurity"],
  ["employer_medicare", "employerMedicare"],
  ["employer_futa", "employerFUTA"],
] as const;

let ctx: TestContext;
let first: QaSeedSummary;
let second: QaSeedSummary;

beforeAll(async () => {
  ctx = await createTestApp();
  first = await seedQaDataset({ db: ctx.db, auth: ctx.auth, config: ctx.config }, { today: TODAY });
  // Re-run immediately — the idempotency half of the contract.
  second = await seedQaDataset(
    { db: ctx.db, auth: ctx.auth, config: ctx.config },
    { today: TODAY },
  );
}, 300_000);

afterAll(async () => {
  await ctx.close();
});

describe("historyMonths", () => {
  it("spans the previous calendar year + current year through last month", () => {
    const months = historyMonths(TODAY);
    expect(months).toHaveLength(EXPECTED_MONTHS);
    expect(months[0]).toEqual({ year: 2025, month: 1 });
    expect(months.at(-1)).toEqual({ year: 2026, month: 7 });
  });
});

describe("QA logins", () => {
  it("creates admin + employee users with the fixed documented credentials", async () => {
    const users = await ctx.db.select().from(authUser);
    const admin = users.find((u) => u.email === QA_ADMIN.email);
    const employee = users.find((u) => u.email === QA_EMPLOYEE_LOGIN.email);
    expect(admin?.role).toBe("admin");
    expect(admin?.banned).toBe(false);
    expect(admin?.twoFactorEnabled).toBe(true);
    expect(employee?.role).toBe("employee");
    expect(employee?.twoFactorEnabled).toBe(true);
  });

  it("stores the FIXED admin TOTP secret — Playwright can compute valid codes", async () => {
    const [adminRow] = await ctx.db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, QA_ADMIN.email))
      .limit(1);
    const [tf] = await ctx.db
      .select()
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, must(adminRow, "admin user").id))
      .limit(1);
    const authCtx = await ctx.auth.$context;
    const secret = await symmetricDecrypt({
      key: authCtx.secretConfig,
      data: must(tf, "twoFactor row").secret,
    });
    expect(secret).toBe(QA_ADMIN.totpSecret);
    const otp = createOTP(secret, { digits: 6, period: 30 });
    expect(await otp.verify(await otp.totp())).toBe(true);
  });
});

describe("W-2 personas", () => {
  it("seeds the three employees with varied work states", async () => {
    const rows = await ctx.db.select().from(employees).where(eq(employees.employmentType, "w2"));
    expect(rows.map((r) => r.legalName).sort()).toEqual([
      "Ada Testworth",
      "Bob Fakeley",
      "Carol Mockington",
    ]);
    // PAY-21: addresses are ciphertext at rest; decrypt for the state spread.
    const states = rows
      .map((r) => must(decryptAddress(r.address, ctx.config.encryptionKey), "address").state)
      .sort();
    expect(states).toEqual(["IL", "TX", "WA"]);
    // Carol carries the QA employee login.
    const carol = must(
      rows.find((r) => r.legalName === "Carol Mockington"),
      "Carol",
    );
    const [login] = await ctx.db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, QA_EMPLOYEE_LOGIN.email))
      .limit(1);
    expect(carol.userId).toBe(must(login, "login user").id);
  });

  it("Ada is W-4 exempt across the whole history", async () => {
    const w4 = await resolveW4(ctx.db, first.w2.ada, "2026-07-01");
    expect(w4?.federalExempt).toBe(true);
    const w4rows = await ctx.db
      .select()
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, first.w2.ada));
    expect(w4rows.every((r) => r.federalExempt)).toBe(true);
  });

  it("Bob has the mid-year salary change (two compensation rows)", async () => {
    const rows = await ctx.db
      .select()
      .from(compensation)
      .where(eq(compensation.employeeId, first.w2.bob));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.periodAmount).sort()).toEqual(["3800.00", "4200.00"]);
  });

  it("Carol has a pending address change request with a comment thread", async () => {
    const [request] = await ctx.db
      .select()
      .from(changeRequests)
      .where(
        and(eq(changeRequests.employeeId, first.w2.carol), eq(changeRequests.status, "pending")),
      )
      .limit(1);
    expect(request).toBeTruthy();
    // PAY-21: the seeded pending payload is ciphertext at rest.
    expect(
      decryptAddress(must(request, "pending request").payload, ctx.config.encryptionKey),
    ).toEqual(QA_CHANGE_REQUEST_ADDRESS);
    const comments = await ctx.db
      .select()
      .from(changeRequestComments)
      .where(eq(changeRequestComments.requestId, must(request, "pending request").id));
    expect(comments.length).toBeGreaterThanOrEqual(3);
  });
});

describe("payroll history", () => {
  it("issues the full history through the real pipeline + one current-period draft", async () => {
    const issued = await ctx.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(eq(payrollRuns.status, "issued"));
    expect(issued).toHaveLength(3 * EXPECTED_MONTHS);

    const drafts = await ctx.db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.status, "awaiting_approval"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.employeeId).toBe(first.w2.ada);
    expect(drafts[0]?.periodStart).toBe("2026-08-01");
  });

  it("every issued run's entries equal its engine snapshot to the cent", async () => {
    const runs = await ctx.db.select().from(payrollRuns).where(eq(payrollRuns.status, "issued"));
    for (const run of runs) {
      const entries = await ctx.db
        .select()
        .from(payrollEntries)
        .where(eq(payrollEntries.runId, run.id));
      const byCategory = new Map(entries.map((e) => [e.category, e.amount]));
      const result = (run.runSnapshot as { result: Record<string, number> }).result;
      for (const [category, field] of ENTRY_FIELDS) {
        expect(
          Number(byCategory.get(category)).toFixed(2),
          `${run.employeeId}/${run.periodStart} ${category}`,
        ).toBe(must(result[field], field).toFixed(2));
      }
    }
  });

  it("Ada's exempt W-4 produces zero federal withholding", async () => {
    const [run] = await ctx.db
      .select()
      .from(payrollRuns)
      .where(
        and(eq(payrollRuns.employeeId, first.w2.ada), eq(payrollRuns.periodStart, "2026-07-01")),
      )
      .limit(1);
    const result = (
      must(run, "Ada 2026-07 run").runSnapshot as { result: { federalWithholding: number } }
    ).result;
    expect(result.federalWithholding).toBe(0);
  });

  it("Bob's July run uses the new salary (mid-year change effective 2026-07-01)", async () => {
    const [run] = await ctx.db
      .select()
      .from(payrollRuns)
      .where(
        and(eq(payrollRuns.employeeId, first.w2.bob), eq(payrollRuns.periodStart, "2026-07-01")),
      )
      .limit(1);
    const snapshot = must(run, "Bob 2026-07 run").runSnapshot as {
      inputs: { periodAmount: number };
    };
    expect(snapshot.inputs.periodAmount).toBe(4200);
  });
});

describe("contractor personas", () => {
  it("year-end summary: Dave above threshold (form required), Erin below with backup withholding", async () => {
    const summary = await yearEndSummary(ctx.db, 2026);
    const dave = must(
      summary.rows.find((r) => r.employeeId === first.contractors.dave),
      "dave row",
    );
    const erin = must(
      summary.rows.find((r) => r.employeeId === first.contractors.erin),
      "erin row",
    );
    expect(dave.reportableTotal).toBe(5600); // 7 × $800
    expect(dave.formRequired).toBe(true);
    expect(erin.reportableTotal).toBe(400);
    expect(erin.formRequired).toBe(false);
    expect(erin.backupWithheldTotal).toBe(96);
  });

  it("Frida has a clean W-8BEN (no form required, not expiring)", async () => {
    const [details] = await ctx.db
      .select()
      .from(contractorDetails)
      .where(eq(contractorDetails.employeeId, first.contractors.frida))
      .limit(1);
    expect(must(details, "frida details").taxForm).toBe("w8ben");
    expect(details?.formExpiresAt).toBe("2028-12-31"); // collected 2025-06-01 + 3 calendar years
    const summary = await yearEndSummary(ctx.db, 2026);
    const frida = must(
      summary.rows.find((r) => r.employeeId === first.contractors.frida),
      "frida row",
    );
    expect(frida.formRequired).toBe(false);
    expect(frida.review1042).toBe(false);
  });

  it("Gustav trips the 1042-S review flag and has a W-8 inside the renewal window", async () => {
    const [details] = await ctx.db
      .select()
      .from(contractorDetails)
      .where(eq(contractorDetails.employeeId, first.contractors.gustav))
      .limit(1);
    expect((must(details, "gustav details").usDaysLog as unknown[]).length).toBeGreaterThan(0);
    expect(details?.formExpiresAt).toBe("2026-09-09"); // today + 20 days
    const summary = await yearEndSummary(ctx.db, 2026);
    const gustav = must(
      summary.rows.find((r) => r.employeeId === first.contractors.gustav),
      "gustav row",
    );
    expect(gustav.review1042).toBe(true);
  });

  it("recurring templates incl. one approved-but-unpaid — the payment-due sweep fires on it", async () => {
    const templates = await ctx.db.select().from(contractorRecurringInvoices);
    expect(templates).toHaveLength(3);

    const [daveTemplate] = templates.filter((t) => t.employeeId === first.contractors.dave);
    const [invoice] = await ctx.db
      .select()
      .from(contractorInvoices)
      .where(eq(contractorInvoices.recurringTemplateId, must(daveTemplate, "dave template").id))
      .limit(1);
    expect(must(invoice, "dave recurring invoice").status).toBe("approved");
    expect(invoice?.recurringPeriod).toBe("2026-07");

    const sweep = await paymentDueSweep({ db: ctx.db, config: ctx.config }, { today: TODAY });
    expect(sweep.due).toBe(1);
  });
});

describe("idempotency", () => {
  it("the re-run created nothing new", async () => {
    expect(second.users.admin.created).toBe(false);
    expect(second.users.employee.created).toBe(false);
    expect(second.payroll.issued).toBe(0);
    expect(second.payroll.existing).toBe(3 * EXPECTED_MONTHS);
    expect(second.payroll.draftCreated).toBe(false);
    expect(second.changeRequestCreated).toBe(false);
    expect(first.payroll.issued).toBe(3 * EXPECTED_MONTHS);
  });

  it("row counts are stable after two runs", async () => {
    const issued = await ctx.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(eq(payrollRuns.status, "issued"));
    expect(issued).toHaveLength(3 * EXPECTED_MONTHS);
    const invoices = await ctx.db.select({ id: contractorInvoices.id }).from(contractorInvoices);
    // Dave: 7 paid + 1 approved-recurring; Erin: 1 paid.
    expect(invoices).toHaveLength(9);
    const comments = await ctx.db
      .select({ id: changeRequestComments.id })
      .from(changeRequestComments);
    expect(comments).toHaveLength(3);
  });
});
