/**
 * Spec 10 integration tests — 1099 contractors. Real SQL via the PGlite
 * harness, requests via app.inject with a real admin session.
 *
 * Covers: contractor CRUD + form-expiry computation + TIN encryption, the
 * invoice state machine, the D17 payment gate (missing/expired form), 24%
 * backup withholding, dated threshold logic with the 1099-K method carve-out,
 * 1042-S review flagging, the on-demand 1099-NEC PDF, payroll-generator
 * isolation (a 1099 worker can never get a payroll run), the D18 export
 * endpoint (shape/auth/no-PII), and W-8 expiry notifications.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  contractorDetails,
  emailOutbox,
  payrollRuns,
  seedDatabase,
} from "@payroll/db";
import { isEncrypted, encryptField } from "../src/crypto/field-encryption.js";
import { checkContractorFormExpiry, formExpiryDate } from "../src/contractors/service.js";
import { generateDraft, generateDraftsForPeriod, monthlyPeriod } from "../src/payroll/runs.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const EXPORT_TOKEN = "test-export-token-0123456789abcdef";
const EXPORT_AUTH = { authorization: `Bearer ${EXPORT_TOKEN}` };

let t: TestContext;
let ADMIN: Record<string, string>;
let adminUserId: string;

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN });
  await seedDatabase(t.db);
  await t.db.update(company).set({ ein: encryptField("12-3456789", t.config.encryptionKey) });
  const admin = await inviteAndOnboard(t, { email: "admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: unknown,
): ReturnType<typeof t.app.inject> {
  return t.app.inject({
    method,
    url,
    headers: ADMIN,
    ...(payload !== undefined ? { payload } : {}),
  });
}

interface ContractorInput {
  legalName?: string;
  hireDate?: string;
  taxStatus?: string;
  entityType?: string;
  residenceCountry?: string;
  tin?: string;
  taxForm?: string;
  formCollectedAt?: string;
  backupWithholding?: boolean;
  servicesLocation?: string;
  usDaysLog?: { year: number; days: number; note?: string }[];
}

async function makeContractor(overrides: ContractorInput = {}): Promise<number> {
  const res = await api("POST", "/api/admin/contractors", {
    legalName: "Casey Contractor",
    hireDate: "2026-01-05",
    taxStatus: "us_person",
    entityType: "individual",
    taxForm: "w9",
    formCollectedAt: "2025-12-01",
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { employeeId: number }).employeeId;
}

async function makeInvoice(
  employeeId: number,
  overrides: { description?: string; amount?: number; invoiceDate?: string } = {},
): Promise<number> {
  const res = await api("POST", `/api/admin/contractors/${employeeId}/invoices`, {
    description: "Consulting services",
    amount: 1000,
    invoiceDate: "2026-02-01",
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { invoice: { id: number } }).invoice.id;
}

async function approve(invoiceId: number): Promise<void> {
  const res = await api("POST", `/api/admin/invoices/${invoiceId}/approve`, {});
  expect(res.statusCode, res.body).toBe(200);
}

async function pay(
  invoiceId: number,
  overrides: { payDate?: string; amount?: number; method?: string; reference?: string } = {},
) {
  return api("POST", `/api/admin/invoices/${invoiceId}/pay`, {
    payDate: "2026-02-15",
    amount: 1000,
    method: "ach",
    ...overrides,
  });
}

/** Create + approve + pay in one go; returns the pay response. */
async function settleInvoice(
  employeeId: number,
  payment: { payDate?: string; amount?: number; method?: string } = {},
  invoice: { amount?: number } = {},
) {
  const invoiceId = await makeInvoice(employeeId, invoice);
  await approve(invoiceId);
  const res = await pay(invoiceId, payment);
  expect(res.statusCode, res.body).toBe(201);
  return res;
}

async function detail(employeeId: number) {
  const res = await api("GET", `/api/admin/contractors/${employeeId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    contractor: {
      id: number;
      legalName: string;
      details: {
        taxForm: string;
        formCollectedAt: string | null;
        formExpiresAt: string | null;
        tinMasked: string | null;
        backupWithholding: boolean;
      };
    };
    invoices: {
      id: number;
      status: string;
      reviewNote: string | null;
      payment: { backupWithheld: string; method: string } | null;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Contractor creation & classification
// ---------------------------------------------------------------------------

describe("contractor creation", () => {
  it("requires residence_country for nonresident contractors", async () => {
    const res = await api("POST", "/api/admin/contractors", {
      legalName: "No Country",
      hireDate: "2026-01-05",
      taxStatus: "nonresident",
      entityType: "individual",
      taxForm: "w8ben",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    expect(res.json().message).toContain("residence_country");
  });

  it("computes W-8BEN expiry as collected + 3 calendar years; TIN encrypted at rest, never returned", async () => {
    const employeeId = await makeContractor({
      legalName: "International Individual",
      taxStatus: "nonresident",
      residenceCountry: "PT",
      taxForm: "w8ben",
      formCollectedAt: "2026-03-15",
      tin: "PT999888777",
    });

    const res = await api("GET", `/api/admin/contractors/${employeeId}`);
    const body = res.json() as Awaited<ReturnType<typeof detail>>;
    // 2026-03-15 + 3 calendar years → valid through the end of 2029.
    expect(body.contractor.details.formExpiresAt).toBe("2029-12-31");
    expect(body.contractor.details.formCollectedAt).toBe("2026-03-15");
    expect(body.contractor.details.tinMasked).toBe("••••8777");
    // The plaintext TIN appears nowhere in the API response…
    expect(res.body).not.toContain("PT999888777");
    expect(res.body).not.toContain('"tin"');
    // …and is encrypted at rest like employees.tax_id.
    const rows = await t.db
      .select()
      .from(contractorDetails)
      .where(eq(contractorDetails.employeeId, employeeId));
    expect(isEncrypted(rows[0]!.tin!)).toBe(true);
  });

  it("w9 has no expiry; expiry recomputes when the form or collected date changes", async () => {
    expect(formExpiryDate("w9", "2026-03-15")).toBeNull();
    expect(formExpiryDate("w8eci", "2026-03-15")).toBeNull();
    expect(formExpiryDate("w8ben_e", "2026-12-30")).toBe("2029-12-31");

    const employeeId = await makeContractor({ legalName: "Form Changer", taxForm: "w8ben" });
    let body = await detail(employeeId);
    expect(body.contractor.details.formExpiresAt).toBe("2028-12-31");

    const patch = await api("PATCH", `/api/admin/contractors/${employeeId}`, {
      formCollectedAt: "2027-01-10",
    });
    expect(patch.statusCode, patch.body).toBe(200);
    body = await detail(employeeId);
    expect(body.contractor.details.formExpiresAt).toBe("2030-12-31");

    const toW9 = await api("PATCH", `/api/admin/contractors/${employeeId}`, { taxForm: "w9" });
    expect(toW9.statusCode).toBe(200);
    body = await detail(employeeId);
    expect(body.contractor.details.formExpiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invoice workflow & state transitions (spec §2)
// ---------------------------------------------------------------------------

describe("invoice workflow", () => {
  it("runs submitted → approved → paid with payment recorded and audit rows", async () => {
    const employeeId = await makeContractor({ legalName: "Happy Path" });
    const res = await settleInvoice(employeeId, { method: "ach", reference: "ach-123" });
    const { invoice, payment } = res.json() as {
      invoice: { status: string };
      payment: { amount: string; backupWithheld: string; method: string };
    };
    expect(invoice.status).toBe("paid");
    expect(payment).toMatchObject({ amount: "1000.00", backupWithheld: "0.00", method: "ach" });

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.actorId, adminUserId), eq(auditEvents.entity, "contractor_invoice")),
      );
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "contractor_invoice.create",
        "contractor_invoice.approve",
        "contractor_invoice.pay",
      ]),
    );
  });

  it("enforces server-side transitions (only approved → paid; reject/void need notes)", async () => {
    const employeeId = await makeContractor({ legalName: "Transition Guard" });

    // pay before approve → 409
    const first = await makeInvoice(employeeId, { description: "Early pay attempt" });
    const earlyPay = await pay(first);
    expect(earlyPay.statusCode).toBe(409);
    expect(earlyPay.json().error).toBe("invalid_transition");

    // approve → approve again → 409
    await approve(first);
    const reapprove = await api("POST", `/api/admin/invoices/${first}/approve`, {});
    expect(reapprove.statusCode).toBe(409);

    // pay → paid; pay again → 409
    expect((await pay(first)).statusCode).toBe(201);
    const repay = await pay(first);
    expect(repay.statusCode).toBe(409);

    // reject without a note → 409; with a note → rejected
    const second = await makeInvoice(employeeId, { description: "Reject me" });
    const noNote = await api("POST", `/api/admin/invoices/${second}/reject`, {});
    expect(noNote.statusCode).toBe(400); // schema requires note
    const rejected = await api("POST", `/api/admin/invoices/${second}/reject`, {
      note: "duplicate submission",
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().invoice.status).toBe("rejected");
    expect(rejected.json().invoice.reviewNote).toBe("duplicate submission");

    // void requires a note; paid is terminal EXCEPT void (spec §2)
    const noVoidNote = await api("POST", `/api/admin/invoices/${first}/void`, { note: "" });
    expect(noVoidNote.statusCode).toBe(400);
    const voided = await api("POST", `/api/admin/invoices/${first}/void`, {
      note: "paid to the wrong account",
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().invoice.status).toBe("void");
    const avoid = await api("POST", `/api/admin/invoices/${first}/void`, { note: "again" });
    expect(avoid.statusCode).toBe(409);
  });

  it("withholds exactly 24% when backup_withholding is set", async () => {
    const employeeId = await makeContractor({
      legalName: "Backup Withheld",
      backupWithholding: true,
    });
    const res = await settleInvoice(employeeId, { amount: 1000 }, { amount: 1000 });
    expect(res.json().payment.backupWithheld).toBe("240.00");

    // Odd amounts round half-up to the cent.
    const odd = await makeInvoice(employeeId, { amount: 333.33 });
    await approve(odd);
    const oddRes = await pay(odd, { amount: 333.33 });
    expect(oddRes.json().payment.backupWithheld).toBe("80.00"); // 333.33 × 0.24 = 79.9992
  });
});

// ---------------------------------------------------------------------------
// Payment gate (spec §4, D17)
// ---------------------------------------------------------------------------

describe("payment gate (D17)", () => {
  it("blocks payment when no form is collected, naming the missing form", async () => {
    const employeeId = await makeContractor({
      legalName: "No Form On File",
      formCollectedAt: undefined,
    });
    const invoiceId = await makeInvoice(employeeId);
    await approve(invoiceId);
    const res = await pay(invoiceId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("form_missing");
    expect(res.json().message).toContain("W-9");
    expect(res.json().message).toContain("No Form On File");

    const body = await detail(employeeId);
    expect(body.invoices[0]!.status).toBe("approved"); // unpaid
  });

  it("blocks payment when the form expired at pay_date, naming the form and date", async () => {
    const employeeId = await makeContractor({
      legalName: "Expired Form",
      taxStatus: "nonresident",
      residenceCountry: "DE",
      taxForm: "w8ben",
      formCollectedAt: "2022-06-01", // expires 2025-12-31
    });
    const invoiceId = await makeInvoice(employeeId);
    await approve(invoiceId);
    const res = await pay(invoiceId, { payDate: "2026-02-01" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("form_expired");
    expect(res.json().message).toContain("W-8BEN");
    expect(res.json().message).toContain("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// Year-end reporting (spec §3)
// ---------------------------------------------------------------------------

describe("year-end reporting", () => {
  // us_person, w9 collected — payments: 2026 ach $1500 + card $800 + wire $600
  // (reportable $2100 of $2900 gross); 2025 ach $700 (reportable ≥ $600).
  let reporter: number;
  let belowThreshold: number;
  let backup: number;
  let usSource: number;

  beforeAll(async () => {
    reporter = await makeContractor({ legalName: "Year End Reporter" });
    await settleInvoice(reporter, { payDate: "2026-03-15", amount: 1500, method: "ach" });
    await settleInvoice(reporter, { payDate: "2026-04-15", amount: 800, method: "card" });
    await settleInvoice(reporter, { payDate: "2026-05-15", amount: 600, method: "wire" });
    await settleInvoice(reporter, { payDate: "2025-11-15", amount: 700, method: "ach" });

    belowThreshold = await makeContractor({ legalName: "Below Threshold" });
    await settleInvoice(belowThreshold, { payDate: "2026-06-15", amount: 500, method: "ach" });

    backup = await makeContractor({ legalName: "945 Backup", backupWithholding: true });
    await settleInvoice(backup, { payDate: "2026-07-15", amount: 1000, method: "check" });

    usSource = await makeContractor({
      legalName: "US Source Days",
      servicesLocation: "mixed",
      usDaysLog: [{ year: 2026, days: 12, note: "on-site visit" }],
    });
    await settleInvoice(usSource, { payDate: "2026-08-15", amount: 9000, method: "ach" });
  }, 120_000);

  function rowFor(rows: { employeeId: number }[], employeeId: number) {
    const row = rows.find((r) => r.employeeId === employeeId);
    expect(row, `year-end row for contractor ${employeeId}`).toBeTruthy();
    return row as Record<string, unknown>;
  }

  it("applies the dated threshold with the 1099-K method carve-out", async () => {
    const y2026 = await api("GET", "/api/admin/contractors/year-end?year=2026");
    expect(y2026.statusCode).toBe(200);
    const body2026 = y2026.json() as { threshold: string; rows: Record<string, unknown>[] };
    expect(body2026.threshold).toBe("2000.00"); // 2026 — OBBBA

    const row = rowFor(body2026.rows, reporter);
    expect(row.reportableTotal).toBe(2100); // card $800 excluded (1099-K)
    expect(row.grossTotal).toBe(2900);
    expect(row.threshold).toBe(2000);
    expect(row.formRequired).toBe(true);
    expect((row.payments as unknown[]).length).toBe(3);

    // Below-threshold contractors stay visible with an explicit flag.
    const below = rowFor(body2026.rows, belowThreshold);
    expect(below.reportableTotal).toBe(500);
    expect(below.formRequired).toBe(false);

    // 2025: the $600 threshold applies to the same contractor's 2025 payment.
    const y2025 = await api("GET", "/api/admin/contractors/year-end?year=2025");
    const body2025 = y2025.json() as { threshold: string; rows: Record<string, unknown>[] };
    expect(body2025.threshold).toBe("600.00");
    expect(rowFor(body2025.rows, reporter).formRequired).toBe(true);
    expect(rowFor(body2025.rows, reporter).reportableTotal).toBe(700);
  });

  it("surfaces backup-withholding totals for the Form 945 reminder", async () => {
    const res = await api("GET", "/api/admin/contractors/year-end?year=2026");
    const row = rowFor(res.json().rows, backup);
    expect(row.backupWithheldTotal).toBe(240); // 24% of $1000
    // $1,000 is below the 2026 $2,000 threshold — visible with "no form required".
    expect(row.formRequired).toBe(false);
  });

  it("flags 1042-S review instead of generating a form for US-source indicators", async () => {
    const res = await api("GET", "/api/admin/contractors/year-end?year=2026");
    const row = rowFor(res.json().rows, usSource);
    expect(row.review1042).toBe(true); // us_days_log non-empty + services_location mixed
    expect(row.formRequired).toBe(false); // even though reportable ≥ threshold

    const pdf = await api("GET", `/api/admin/contractors/${usSource}/1099-nec?year=2026`);
    expect(pdf.statusCode).toBe(409);
    expect(pdf.json().error).toBe("review_1042_required");
  });

  it("generates the 1099-NEC PDF on demand; 409 below threshold or without a valid form", async () => {
    const pdf = await api("GET", `/api/admin/contractors/${reporter}/1099-nec?year=2026`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("1099-nec-2026");
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const below = await api("GET", `/api/admin/contractors/${belowThreshold}/1099-nec?year=2026`);
    expect(below.statusCode).toBe(409);
    expect(below.json().error).toBe("no_form_required");
    expect(below.json().message).toContain("below the 2026 threshold");
  });

  it("threshold config is admin-editable per year", async () => {
    const put = await api("PUT", "/api/admin/contractor-reporting-config", {
      taxYear: 2027,
      necThreshold: 2100,
      note: "indexed",
    });
    expect(put.statusCode).toBe(200);
    const list = await api("GET", "/api/admin/contractor-reporting-config");
    const years = (list.json().config as { taxYear: number; necThreshold: string }[]).map((c) => [
      c.taxYear,
      c.necThreshold,
    ]);
    expect(years).toContainEqual([2025, "600.00"]);
    expect(years).toContainEqual([2026, "2000.00"]);
    expect(years).toContainEqual([2027, "2100.00"]);
  });
});

// ---------------------------------------------------------------------------
// Payroll generator isolation (spec §4)
// ---------------------------------------------------------------------------

describe("payroll generator isolation", () => {
  it("a 1099 worker can never produce a payroll run", async () => {
    const employeeId = await makeContractor({ legalName: "Never Payroll" });
    const deps = { db: t.db, config: t.config };

    // Direct generation: hard assertion.
    await expect(
      generateDraft(deps, {
        employeeId,
        period: monthlyPeriod(2026, 3, 15),
        createdBy: "test",
      }),
    ).rejects.toThrow(/never payroll runs/);

    // Single-employee bulk path: skipped with the named reason.
    const single = await generateDraftsForPeriod(deps, {
      year: 2026,
      month: 3,
      employeeId,
      autoDraftOnly: false,
      createdBy: "test",
    });
    expect(single.generated).toHaveLength(0);
    expect(single.skipped).toEqual([{ employeeId, reason: "not_w2_employee" }]);

    // Company-wide path: the contractor is filtered out entirely.
    const bulk = await generateDraftsForPeriod(deps, {
      year: 2026,
      month: 3,
      autoDraftOnly: false,
      createdBy: "test",
    });
    expect(bulk.generated.find((r) => r.employeeId === employeeId)).toBeUndefined();

    // And no run row exists, whatever the path.
    const runs = await t.db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.employeeId, employeeId));
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Export API (spec §5, D18)
// ---------------------------------------------------------------------------

describe("export API — contractor-payments", () => {
  let exporter: number;

  beforeAll(async () => {
    exporter = await makeContractor({
      legalName: "Export Subject",
      tin: "123456789",
      backupWithholding: true,
    });
    await settleInvoice(exporter, { payDate: "2026-03-15", amount: 2500, method: "ach" });
    await settleInvoice(exporter, {
      payDate: "2026-04-15",
      amount: 900,
      method: "third_party_network",
    });
  }, 120_000);

  it("401 without a token, 400 on a missing/bad year", async () => {
    const noToken = await t.app.inject({
      method: "GET",
      url: "/api/export/contractor-payments?year=2026",
    });
    expect(noToken.statusCode).toBe(401);

    for (const url of [
      "/api/export/contractor-payments",
      "/api/export/contractor-payments?year=26",
    ]) {
      const res = await t.app.inject({ method: "GET", url, headers: EXPORT_AUTH });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("invalid_year");
    }
  });

  it("returns the documented shape — form status, payments, threshold, flags — with no TIN/bank/address", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/contractor-payments?year=2026",
      headers: EXPORT_AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      company: { legalName: string; ein: string };
      year: number;
      threshold: string;
      contractors: Record<string, unknown>[];
    };
    expect(body.company).toEqual({ legalName: "SOULT IO LTD", ein: "12-3456789" });
    expect(body.year).toBe(2026);
    expect(body.threshold).toBe("2000.00");

    const row = body.contractors.find((c) => c.employeeId === exporter) as Record<string, unknown>;
    expect(row).toMatchObject({
      legalName: "Export Subject",
      taxStatus: "us_person",
      entityType: "individual",
      formRequired: true,
      reportableTotal: "2500.00", // third_party_network $900 excluded
      grossTotal: "3400.00",
      backupWithheldTotal: "816.00", // 24% of 3400
      threshold: "2000.00",
    });
    expect(row.form).toMatchObject({ taxForm: "w9", collected: true, expired: false });
    const payments = row.payments as { method: string; amount: string; backupWithheld: string }[];
    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({
      method: "ach",
      amount: "2500.00",
      backupWithheld: "600.00",
    });

    // No surplus PII anywhere in the payload.
    expect(res.body).not.toContain("123456789");
    expect(res.body).not.toContain('"tin"');
    expect(res.body).not.toContain("bank");
    expect(res.body).not.toContain("address");
  });
});

// ---------------------------------------------------------------------------
// W-8 expiry notifications (spec §4 — W-4 renewal pattern)
// ---------------------------------------------------------------------------

describe("W-8 expiry notifications", () => {
  it("notifies admins 30 days before expiry and at expiry, idempotently", async () => {
    // Collected 2023-08-20 → expires 2026-12-31.
    const employeeId = await makeContractor({
      legalName: "Expiry Watch",
      taxStatus: "nonresident",
      residenceCountry: "ES",
      taxForm: "w8ben",
      formCollectedAt: "2023-08-20",
    });

    // "Expired Form" (payment-gate describe) is already expired at this date —
    // it legitimately joins the sweep; the expiring count is the new one.
    const first = await checkContractorFormExpiry(
      { db: t.db, config: t.config },
      { today: "2026-12-10" },
    );
    expect(first).toEqual({ expiring: 1, expired: 1 });

    const outbox = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "contractor_form_expiring"));
    expect(outbox).toHaveLength(1); // one admin
    expect(outbox[0]!.userId).toBe(adminUserId);
    expect(outbox[0]!.subject).toContain("W-8BEN");
    expect(outbox[0]!.bodyHtml).toContain("Expiry Watch");
    expect(outbox[0]!.bodyHtml).toContain("2026-12-31");

    // Idempotent: the daily sweep must not re-mail for the same form expiry.
    const again = await checkContractorFormExpiry(
      { db: t.db, config: t.config },
      { today: "2026-12-11" },
    );
    expect(again).toEqual({ expiring: 0, expired: 0 });

    // At expiry the "form outstanding" gate re-arms and admins hear about it.
    const expired = await checkContractorFormExpiry(
      { db: t.db, config: t.config },
      { today: "2027-01-05" },
    );
    expect(expired).toEqual({ expiring: 0, expired: 1 });
    const expiredRows = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "contractor_form_expired"));
    expect(expiredRows.some((r) => r.bodyHtml.includes("Expiry Watch"))).toBe(true);

    // The year-end view shows the form expired as of the same date.
    void employeeId;
  });
});
