/**
 * Spec 11 — PII capture integration tests (real SQL via the PGlite harness).
 *
 * D19: company EIN admin-editable — validate/normalize/encrypt, masked reads,
 *      masked-only audit.
 * D20a: admin direct-set employee TIN — same validation + encryption as the
 *       create path, write-only, masked-only audit.
 * D20b/D21: employee 'tax_id' change request — ciphertext-only payload at
 *       rest, masked review, audit-logged reveal-on-demand, approve applies
 *       encrypted. Negative sweep: the plaintext TIN appears NOWHERE in
 *       change_requests / change_request_comments / audit_events / outbox.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  changeRequestComments,
  changeRequests,
  company,
  emailOutbox,
  employees,
  seedDatabase,
  SEED_COMPANY_NAME,
  type SeedDb,
} from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { decryptField } from "../src/crypto/field-encryption.js";

let t: TestContext;
let adminCookie: string;
let adminId: string;
let employeeCookie: string;
let employeeUserId: string;
let employeeId: number;

const TIN = "123456789";
const TIN_MASKED = "••••6789";

/** JSON.stringify that survives bigserial BigInt ids. */
function json(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? Number(v) : v));
}

function nextMonthStart(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 2; // next month
  const y = month > 12 ? year + 1 : year;
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

async function auditsFor(action: string, entityId: string) {
  return t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)));
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);

  const admin = await inviteAndOnboard(t, { email: "pii-admin@example.com", role: "admin" });
  adminId = admin.userId;
  adminCookie = (await login(t, admin.email, TEST_PASSWORD)).sessionCookie;

  const employee = await inviteAndOnboard(t, {
    email: "pii-employee@example.com",
    role: "employee",
  });
  employeeUserId = employee.userId;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const inserted = await t.db
    .insert(employees)
    .values({
      userId: employee.userId,
      companyId: companyRows[0]!.id,
      legalName: "Pii Employee",
      hireDate: "2024-01-01",
    })
    .returning();
  employeeId = inserted[0]!.id;
  employeeCookie = (await login(t, employee.email, TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

describe("company EIN (D19)", () => {
  it("rejects an invalid EIN", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
      payload: { legalName: SEED_COMPANY_NAME, ein: "123" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_body");
  });

  it("validates, normalizes, encrypts, and audits masked-only", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
      payload: { legalName: SEED_COMPANY_NAME, ein: "123456789" }, // dash optional on input
    });
    expect(res.statusCode).toBe(200);
    const { company: updated } = res.json() as { company: { id: number; einMasked: string } };
    expect(updated.einMasked).toBe(TIN_MASKED);

    // At rest: encrypted, normalized to XX-XXXXXXX.
    const [row] = await t.db.select().from(company).where(eq(company.id, updated.id));
    expect(row!.ein!.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(row!.ein!, t.config.encryptionKey)).toBe("12-3456789");

    // Reads stay masked.
    const get = await t.app.inject({
      method: "GET",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
    });
    expect((get.json() as { company: { einMasked: string } }).company.einMasked).toBe(TIN_MASKED);

    // Audit: masked before/after only — plaintext EIN nowhere in the row.
    const audits = await auditsFor("company.update", String(updated.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toMatchObject({ einMasked: null }); // was unset
    expect(audits[0]!.after).toMatchObject({ einMasked: TIN_MASKED });
    const serialized = json(audits[0]);
    expect(serialized).not.toContain("12-3456789");
    expect(serialized).not.toContain("123456789");
  });

  it("records masked before→after on change and leaves EIN untouched when omitted", async () => {
    const [row] = await t.db.select().from(company).limit(1);

    const res = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
      payload: { legalName: SEED_COMPANY_NAME, ein: "98-7654321" },
    });
    expect(res.statusCode).toBe(200);
    const audits = await auditsFor("company.update", String(row!.id));
    const last = audits[audits.length - 1]!;
    expect(last.before).toMatchObject({ einMasked: TIN_MASKED });
    expect(last.after).toMatchObject({ einMasked: "••••4321" });

    // Omitting ein keeps the stored value.
    const noEin = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
      payload: { legalName: SEED_COMPANY_NAME },
    });
    expect(noEin.statusCode).toBe(200);
    const [after] = await t.db.select().from(company).where(eq(company.id, row!.id));
    expect(decryptField(after!.ein!, t.config.encryptionKey)).toBe("98-7654321");

    // Restore the original test EIN for any later assertions.
    await t.app.inject({
      method: "PUT",
      url: "/api/admin/company",
      headers: sessionHeader(adminCookie),
      payload: { legalName: SEED_COMPANY_NAME, ein: TIN },
    });
  });
});

describe("admin direct-set employee TIN (D20a)", () => {
  it("rejects an invalid TIN and non-admin callers", async () => {
    const invalid = await t.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${employeeId}`,
      headers: sessionHeader(adminCookie),
      payload: { taxId: "12345" },
    });
    expect(invalid.statusCode).toBe(400);

    const notAdmin = await t.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${employeeId}`,
      headers: sessionHeader(employeeCookie),
      payload: { taxId: TIN },
    });
    expect(notAdmin.statusCode).toBe(403);
  });

  it("encrypts at rest, stays write-only in the directory API, audits masked-only", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${employeeId}`,
      headers: sessionHeader(adminCookie),
      payload: { taxId: TIN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { employee: Record<string, unknown> };
    expect(body.employee.hasTaxId).toBe(true);
    expect("taxId" in body.employee).toBe(false);
    expect(json(body)).not.toContain(TIN);

    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(row!.taxId!.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(row!.taxId!, t.config.encryptionKey)).toBe(TIN);

    const audits = await auditsFor("employee.set_tax_id", String(employeeId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toMatchObject({ taxIdMasked: null });
    expect(audits[0]!.after).toMatchObject({ taxIdMasked: TIN_MASKED });
    expect(json(audits[0])).not.toContain(TIN);

    // Detail read: presence flag only, never the value.
    const detail = await t.app.inject({
      method: "GET",
      url: `/api/admin/employees/${employeeId}`,
      headers: sessionHeader(adminCookie),
    });
    const detailBody = detail.json() as { employee: Record<string, unknown> };
    expect(detailBody.employee.hasTaxId).toBe(true);
    expect(json(detailBody)).not.toContain(TIN);
  });
});

describe("employee tax_id change request (D20b/D21)", () => {
  let publicId: string;

  it("submit stores ONLY ciphertext in the payload and masks every response", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: sessionHeader(employeeCookie),
      payload: { requestType: "tax_id", payload: { taxId: TIN }, effectiveFrom: nextMonthStart() },
    });
    expect(res.statusCode).toBe(201);
    const { request } = res.json() as {
      request: { publicId: string; payload: { taxId: string } };
    };
    publicId = request.publicId;
    expect(request.payload.taxId).toBe(TIN_MASKED);

    // At rest: the JSONB holds only ciphertext.
    const [stored] = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    const storedPayload = stored!.payload as { taxId: string };
    expect(storedPayload.taxId.startsWith("enc:v1:")).toBe(true);
    expect(json(storedPayload)).not.toContain(TIN);
    expect(decryptField(storedPayload.taxId, t.config.encryptionKey)).toBe(TIN);

    // List + detail responses are masked for admin and employee alike.
    const list = await t.app.inject({
      method: "GET",
      url: "/api/change-requests?requestType=tax_id",
      headers: sessionHeader(adminCookie),
    });
    const listed = (list.json() as { requests: { payload: { taxId: string } }[] }).requests;
    expect(listed[0]!.payload.taxId).toBe(TIN_MASKED);

    const detail = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}`,
      headers: sessionHeader(employeeCookie),
    });
    expect(json(detail.json())).not.toContain(TIN);

    // One pending per (employee, type) covers tax_id automatically.
    const dupe = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: sessionHeader(employeeCookie),
      payload: { requestType: "tax_id", payload: { taxId: TIN }, effectiveFrom: nextMonthStart() },
    });
    expect(dupe.statusCode).toBe(409);
    expect((dupe.json() as { error: string }).error).toBe("duplicate_pending");
  });

  it("reveal-on-demand is admin-only and audit-logged", async () => {
    const asEmployee = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}/reveal-tax-id`,
      headers: sessionHeader(employeeCookie),
    });
    expect(asEmployee.statusCode).toBe(403);

    const asAdmin = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}/reveal-tax-id`,
      headers: sessionHeader(adminCookie),
    });
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.json() as { taxId: string }).taxId).toBe(TIN);

    // The reveal itself is audited — the value is not.
    const reveals = await auditsFor("change_request.reveal_tax_id", publicId);
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.actorId).toBe(adminId);
    expect(json(reveals[0])).not.toContain(TIN);
  });

  it("approve applies the TIN encrypted; masked-only audit; plaintext nowhere", async () => {
    // A comment + an approval note exercise the thread paths.
    await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/comments`,
      headers: sessionHeader(adminCookie),
      payload: { body: "Verifying against the filed W-4." },
    });
    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: { note: "Approved and applied." },
    });
    expect(approve.statusCode).toBe(200);
    const { request } = approve.json() as { request: { status: string; payload: unknown } };
    expect(request.status).toBe("approved");
    expect(json(request.payload)).not.toContain(TIN);

    // Applied to employees.tax_id in encrypted form (effective-dated like
    // other types — the effective-date rule ran as part of approval).
    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(decryptField(row!.taxId!, t.config.encryptionKey)).toBe(TIN);

    const approvals = await auditsFor("change_request.approve", publicId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.before).toMatchObject({ taxIdMasked: TIN_MASKED }); // set by D20a test
    expect(json(approvals[0])).not.toContain(TIN);

    // ---- Negative sweep: the plaintext TIN appears NOWHERE ----
    const [storedRequest] = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    expect(json(storedRequest)).not.toContain(TIN);

    const comments = await t.db
      .select()
      .from(changeRequestComments)
      .where(eq(changeRequestComments.requestId, storedRequest!.id));
    expect(json(comments)).not.toContain(TIN);

    const allAudits = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, publicId));
    expect(allAudits.length).toBeGreaterThan(0);
    expect(json(allAudits)).not.toContain(TIN);

    // Notification payloads (submitted → admins, approved → employee).
    const outbox = await t.db.select().from(emailOutbox);
    const related = outbox.filter(
      (m) =>
        (m.eventType === "change_request_submitted" || m.eventType === "change_request_approved") &&
        (m.userId === adminId || m.userId === employeeUserId),
    );
    expect(related.length).toBeGreaterThan(0);
    expect(json(related)).not.toContain(TIN);
  });
});
