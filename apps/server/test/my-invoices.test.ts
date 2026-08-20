/**
 * PAY-7 integration tests — contractor self-service invoices
 * (GET /api/my/invoices + /api/my/invoices/:id/pdf).
 *
 * Covers: the D1 visibility rule (approved + paid only — submitted, rejected
 * and void never leave the server), per-contractor scoping (no enumeration —
 * foreign IDs 404), the 1:1 payment join, W-2/unlinked accounts getting an
 * empty list, and auth gating on both endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { company, employees, seedDatabase } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

/** Contractor A (linked user), contractor B (linked user), W-2 (linked user). */
let cookieA: string;
let cookieB: string;
let cookieW2: string;
let invoiceIdsA: {
  submitted: number;
  approved: number;
  paid: number;
  rejected: number;
  voided: number;
};
let invoiceIdB: number;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db);
  const admin = await inviteAndOnboard(t, { email: "admin@test.dev", role: "admin" });
  const adminSession = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(adminSession.sessionCookie);

  const userA = await inviteAndOnboard(t, { email: "contractor-a@test.dev" });
  const userB = await inviteAndOnboard(t, { email: "contractor-b@test.dev" });
  const userW2 = await inviteAndOnboard(t, { email: "w2@test.dev" });

  // Contractor employee records via the admin API (creates details row too).
  const contractorA = await makeContractor("Casey Contractor-A");
  const contractorB = await makeContractor("Blair Contractor-B");
  await t.db.update(employees).set({ userId: userA.userId }).where(eq(employees.id, contractorA));
  await t.db.update(employees).set({ userId: userB.userId }).where(eq(employees.id, contractorB));

  // W-2 employee record linked to userW2 (direct insert — no admin API needed).
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  await t.db.insert(employees).values({
    companyId: companyRows[0]!.id,
    employmentType: "w2",
    legalName: "Wanda W2",
    hireDate: "2026-01-05",
    userId: userW2.userId,
  });

  // Contractor A: one invoice per status.
  const submitted = await makeInvoice(contractorA, { description: "A submitted" });
  const toApprove = await makeInvoice(contractorA, { description: "A approved" });
  const toPay = await makeInvoice(contractorA, { description: "A paid" });
  const toReject = await makeInvoice(contractorA, { description: "A rejected" });
  const toVoid = await makeInvoice(contractorA, { description: "A voided" });

  await review(toApprove, "approve");
  await review(toPay, "approve");
  await pay(toPay);
  await review(toReject, "reject");
  await voidInvoice(toVoid);

  // Contractor B: one paid invoice.
  invoiceIdB = await makeInvoice(contractorB, { description: "B paid" });
  await review(invoiceIdB, "approve");
  await pay(invoiceIdB);

  invoiceIdsA = { submitted, approved: toApprove, paid: toPay, rejected: toReject, voided: toVoid };

  cookieA = (await login(t, userA.email, TEST_PASSWORD)).sessionCookie;
  cookieB = (await login(t, userB.email, TEST_PASSWORD)).sessionCookie;
  cookieW2 = (await login(t, userW2.email, TEST_PASSWORD)).sessionCookie;
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Admin-side setup helpers
// ---------------------------------------------------------------------------

async function api(
  method: "GET" | "POST",
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

async function makeContractor(legalName: string): Promise<number> {
  const res = await api("POST", "/api/admin/contractors", {
    legalName,
    hireDate: "2026-01-05",
    taxStatus: "us_person",
    entityType: "individual",
    taxForm: "w9",
    formCollectedAt: "2025-12-01",
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { employeeId: number }).employeeId;
}

async function makeInvoice(
  employeeId: number,
  overrides: { description: string },
): Promise<number> {
  const res = await api("POST", `/api/admin/contractors/${employeeId}/invoices`, {
    amount: 1000,
    invoiceDate: "2026-02-01",
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { invoice: { id: number } }).invoice.id;
}

async function review(invoiceId: number, action: "approve" | "reject"): Promise<void> {
  const res = await api("POST", `/api/admin/invoices/${invoiceId}/${action}`, {
    ...(action === "reject" ? { note: "not needed" } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function pay(invoiceId: number): Promise<void> {
  const res = await api("POST", `/api/admin/invoices/${invoiceId}/pay`, {
    payDate: "2026-02-15",
    amount: 1000,
    method: "ach",
    reference: "ACH-TEST-1",
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function voidInvoice(invoiceId: number): Promise<void> {
  const res = await api("POST", `/api/admin/invoices/${invoiceId}/void`, { note: "duplicate" });
  expect(res.statusCode, res.body).toBe(200);
}

// ---------------------------------------------------------------------------
// The self-service surface
// ---------------------------------------------------------------------------

interface MyInvoiceDto {
  id: number;
  invoiceDate: string;
  description: string;
  amount: number;
  currency: string;
  status: string;
  recurringPeriod: string | null;
  payment: {
    payDate: string;
    amount: number;
    method: string;
    reference: string | null;
    backupWithheld: number;
  } | null;
}

async function myInvoices(cookie: string): Promise<MyInvoiceDto[]> {
  const res = await t.app.inject({
    method: "GET",
    url: "/api/my/invoices",
    headers: sessionHeader(cookie),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { invoices: MyInvoiceDto[] }).invoices;
}

describe("GET /api/my/invoices", () => {
  it("a contractor sees exactly their approved + paid invoices (D1 visibility)", async () => {
    const invoices = await myInvoices(cookieA);
    const ids = invoices.map((i) => i.id).sort();
    expect(ids).toEqual([invoiceIdsA.approved, invoiceIdsA.paid].sort());
    // submitted / rejected / void never leave the server:
    expect(ids).not.toContain(invoiceIdsA.submitted);
    expect(ids).not.toContain(invoiceIdsA.rejected);
    expect(ids).not.toContain(invoiceIdsA.voided);
  });

  it("the paid invoice carries the 1:1 payment join", async () => {
    const invoices = await myInvoices(cookieA);
    const paid = invoices.find((i) => i.id === invoiceIdsA.paid)!;
    expect(paid.status).toBe("paid");
    expect(paid.payment).toEqual({
      payDate: "2026-02-15",
      amount: 1000,
      method: "ach",
      reference: "ACH-TEST-1",
      backupWithheld: 0,
    });
    const approved = invoices.find((i) => i.id === invoiceIdsA.approved)!;
    expect(approved.status).toBe("approved");
    expect(approved.payment).toBeNull();
  });

  it("contractor B sees only their own invoices", async () => {
    const invoices = await myInvoices(cookieB);
    expect(invoices.map((i) => i.id)).toEqual([invoiceIdB]);
  });

  it("a W-2 employee gets an empty list (they have payslips instead)", async () => {
    expect(await myInvoices(cookieW2)).toEqual([]);
  });

  it("unauthenticated requests are rejected", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/my/invoices" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/my/invoices/:id/pdf", () => {
  it("renders an on-demand PDF for the contractor's own paid invoice", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/my/invoices/${invoiceIdsA.paid}/pdf`,
      headers: sessionHeader(cookieA),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('inline; filename="invoice-2026-02-01.pdf"');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("also renders for approved (unpaid) invoices", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/my/invoices/${invoiceIdsA.approved}/pdf`,
      headers: sessionHeader(cookieA),
    });
    expect(res.statusCode).toBe(200);
  });

  it("404s a foreign invoice (no enumeration)", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/my/invoices/${invoiceIdB}/pdf`,
      headers: sessionHeader(cookieA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s invoices in hidden statuses (submitted/rejected/void)", async () => {
    for (const id of [invoiceIdsA.submitted, invoiceIdsA.rejected, invoiceIdsA.voided]) {
      const res = await t.app.inject({
        method: "GET",
        url: `/api/my/invoices/${id}/pdf`,
        headers: sessionHeader(cookieA),
      });
      expect(res.statusCode, `invoice ${id}`).toBe(404);
    }
  });

  it("404s for a W-2 employee even on a real invoice id", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/my/invoices/${invoiceIdsA.paid}/pdf`,
      headers: sessionHeader(cookieW2),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s non-integer ids and rejects unauthenticated requests", async () => {
    const bad = await t.app.inject({
      method: "GET",
      url: "/api/my/invoices/abc/pdf",
      headers: sessionHeader(cookieA),
    });
    expect(bad.statusCode).toBe(404);
    const anon = await t.app.inject({
      method: "GET",
      url: `/api/my/invoices/${invoiceIdsA.paid}/pdf`,
    });
    expect(anon.statusCode).toBe(401);
  });
});
