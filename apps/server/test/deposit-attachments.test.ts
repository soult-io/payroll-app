/**
 * PAY-27 integration tests — deposit attachments (EFTPS confirmation/
 * evidence PDFs on tax deposits). Real SQL via the PGlite harness; routes
 * through app.inject with real sessions.
 *
 * Covers: upload → list → download round-trip (byte-identical), ciphertext
 * at rest (AES-256-GCM in the bytea column), PDF magic-byte validation,
 * filename sanitization, RBAC (admin-only read + write), cross-deposit 404,
 * and audit rows for both upload and download. Mirrors the PAY-24
 * filing-attachments coverage shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditEvents,
  depositAttachments,
  seedDatabase,
  taxDeposits,
  type SeedDb,
} from "@payroll/db";
import { decryptBytes } from "../src/crypto/field-encryption.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailerpark\n%%EOF\n",
  "utf8",
);

let t: TestContext;
let ADMIN: Record<string, string>;
let EMPLOYEE: Record<string, string>;
let depositId: number;

function upload(
  headers: Record<string, string>,
  id: number,
  opts: { filename?: string; body?: Buffer; contentType?: string } = {},
) {
  return t.app.inject({
    method: "POST",
    url: `/api/admin/tax-deposits/${id}/attachments${opts.filename ? `?filename=${encodeURIComponent(opts.filename)}` : ""}`,
    headers: { ...headers, "content-type": opts.contentType ?? "application/pdf" },
    payload: opts.body ?? PDF_BYTES,
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "dep-att-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  const employee = await inviteAndOnboard(t, { email: "dep-att-emp@test.dev", role: "employee" });
  EMPLOYEE = sessionHeader((await login(t, employee.email, TEST_PASSWORD)).sessionCookie);

  const inserted = await t.db
    .insert(taxDeposits)
    .values({ periodStart: "2026-08-01", amount: "1234.56", dueDate: "2026-09-15" })
    .returning({ id: taxDeposits.id });
  depositId = inserted[0]?.id ?? -1;
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("upload → list → download round-trip", () => {
  it("stores ciphertext at rest and returns byte-identical downloads", async () => {
    const res = await upload(ADMIN, depositId, { filename: "eftps-ack-august.pdf" });
    expect(res.statusCode, res.body).toBe(201);
    const { attachment } = res.json() as {
      attachment: { id: number; filename: string; sizeBytes: number; uploadedBy: string };
    };
    expect(attachment.filename).toBe("eftps-ack-august.pdf");
    expect(attachment.sizeBytes).toBe(PDF_BYTES.length);

    // At rest: bytea ciphertext — no %PDF anywhere, decrypts to the original.
    const rows = await t.db
      .select()
      .from(depositAttachments)
      .where(eq(depositAttachments.id, attachment.id));
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.data.includes(Buffer.from("%PDF-"))).toBe(false);
    expect(stored.sizeBytes).toBe(PDF_BYTES.length);
    expect(decryptBytes(stored.data, t.config.encryptionKey).equals(PDF_BYTES)).toBe(true);

    // List: metadata only, visible after a fresh query (survives "reload").
    const list = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${depositId}/attachments`,
      headers: ADMIN,
    });
    expect(list.statusCode, list.body).toBe(200);
    const { attachments } = list.json() as {
      attachments: { id: number; filename: string }[];
    };
    expect(attachments.map((a) => a.id)).toContain(attachment.id);
    expect(list.body).not.toContain("%PDF");

    // Download: byte-identical, inline PDF disposition.
    const dl = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${depositId}/attachments/${attachment.id}/download`,
      headers: ADMIN,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("application/pdf");
    expect(dl.headers["content-disposition"]).toContain("eftps-ack-august.pdf");
    expect(dl.rawPayload.equals(PDF_BYTES)).toBe(true);

    // Audit: one upload row + one download row.
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        inArray(auditEvents.action, ["tax_deposit.attach", "tax_deposit.download_attachment"]),
      );
    const acts = audits.map((a) => a.action).sort();
    expect(acts).toEqual(["tax_deposit.attach", "tax_deposit.download_attachment"]);
    expect(audits.every((a) => a.entityId === String(depositId))).toBe(true);
  });

  it("sanitizes pathy filenames", async () => {
    const res = await upload(ADMIN, depositId, { filename: "..\\..\\etc\\evil.pdf" });
    expect(res.statusCode, res.body).toBe(201);
    const { attachment } = res.json() as { attachment: { filename: string } };
    expect(attachment.filename).toBe("evil.pdf");
  });
});

describe("validation", () => {
  it("rejects non-PDF bytes (magic check), JSON bodies, and unknown deposits", async () => {
    const notPdf = await upload(ADMIN, depositId, { body: Buffer.from("definitely not a pdf") });
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json()).toMatchObject({ error: "invalid_input" });

    const json = await upload(ADMIN, depositId, {
      body: Buffer.from("{}"),
      contentType: "application/json",
    });
    expect(json.statusCode).toBe(415);

    const missing = await upload(ADMIN, 999999);
    expect(missing.statusCode).toBe(404);

    const listMissing = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-deposits/999999/attachments",
      headers: ADMIN,
    });
    expect(listMissing.statusCode).toBe(404);
  });
});

describe("RBAC + tenancy", () => {
  it("employees cannot upload, list, or download attachments", async () => {
    expect((await upload(EMPLOYEE, depositId)).statusCode).toBe(403);
    const list = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${depositId}/attachments`,
      headers: EMPLOYEE,
    });
    expect(list.statusCode).toBe(403);
    const dl = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${depositId}/attachments/1/download`,
      headers: EMPLOYEE,
    });
    expect(dl.statusCode).toBe(403);
    // Unauthenticated: 401.
    const anon = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${depositId}/attachments`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("an attachment cannot be downloaded through another deposit's URL", async () => {
    const other = await t.db
      .insert(taxDeposits)
      .values({ periodStart: "2026-09-01", amount: "999.00", dueDate: "2026-10-15" })
      .returning({ id: taxDeposits.id });
    const dl = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-deposits/${other[0]?.id ?? -2}/attachments/1/download`,
      headers: ADMIN,
    });
    expect(dl.statusCode).toBe(404);
  });
});
