/**
 * PAY-21 integration tests — field-level encryption at rest for employee
 * address data: employees.address / mailing_address, the effective-dated
 * history in change_requests.payload, and the pre-change snapshots in
 * audit_events before/after. Real SQL via the PGlite harness; routes go
 * through app.inject with real sessions.
 *
 * Fixture: one admin-created employee (API round-trip), one account-linked
 * employee created directly with ciphertext (profile + change-request flow),
 * and one LEGACY plaintext employee + approved mailing_address request +
 * approve-shaped audit row (the in-place data migration).
 *
 * Covers: crypto round-trip / idempotency / legacy tolerance, DB ciphertext
 * vs API-decrypted reads on every surface (admin detail, /my/profile,
 * change-request list + submit response), encrypted audit snapshots feeding
 * as-of resolution (incl. pre-first-change `before` recovery), and the
 * encryptStoredAddresses migration rewriting all three stores idempotently
 * while resolution keeps returning the original objects.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  changeRequests,
  company,
  employees,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import type { AddressPayload } from "@payroll/shared";
import {
  addressForStorage,
  decryptAddress,
  encryptAddress,
  isAddressEncrypted,
} from "../src/crypto/address-encryption.js";
import { resolveEmployeeAddressAt } from "../src/change-requests/address-history.js";
import { encryptStoredAddresses } from "../src/migrate/address-encryption.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const UNIT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ADDR = {
  line1: "1 Encryption Way",
  city: "Cipherville",
  state: "CV",
  zip: "12345",
  country: "US",
} satisfies AddressPayload;
const ADDR_NEW = {
  line1: "2 Rotation Rd",
  city: "Keytown",
  state: "KT",
  zip: "23456",
  country: "US",
} satisfies AddressPayload;
const MAIL_SELF = {
  line1: "PO Box 42",
  city: "Cipherville",
  state: "CV",
  zip: "12345",
  country: "US",
} satisfies AddressPayload;
const MAIL_OLD = {
  line1: "10 Legacy Ln",
  city: "Plaintown",
  state: "PT",
  zip: "34567",
  country: "US",
} satisfies AddressPayload;
const MAIL_NEW = {
  line1: "20 Cipher Ct",
  city: "Plaintown",
  state: "PT",
  zip: "34568",
  country: "US",
} satisfies AddressPayload;

let t: TestContext;
let ADMIN: Record<string, string>;
let selfSession: Record<string, string>;
let selfEmployeeId: number;
let migEmployeeId: number;

function nextMonthStart(): string {
  const now = new Date();
  const month = now.getUTCMonth() + 2;
  const y = month > 12 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function insertEmployee(
  legalName: string,
  opts: { userId?: string; address?: unknown; mailingAddress?: unknown } = {},
): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate: "2025-01-01",
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.address !== undefined ? { address: opts.address } : {}),
      ...(opts.mailingAddress !== undefined ? { mailingAddress: opts.mailingAddress } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function rawEmployee(id: number) {
  const rows = await t.db.select().from(employees).where(eq(employees.id, id));
  const row = rows[0];
  if (!row) throw new Error(`employee ${id} missing`);
  return row;
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "enc-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  // Account-linked employee, stored encrypted from birth.
  const self = await inviteAndOnboard(t, { email: "enc-self@test.dev", name: "Enc Self" });
  selfSession = sessionHeader((await login(t, self.email, TEST_PASSWORD)).sessionCookie);
  selfEmployeeId = await insertEmployee("Enc Self", {
    userId: self.userId,
    address: encryptAddress(ADDR, t.config.encryptionKey),
    mailingAddress: encryptAddress(MAIL_SELF, t.config.encryptionKey),
  });

  // Legacy plaintext fixture for the data migration: current value, an
  // approved mailing_address request, and its approve-shaped audit row.
  migEmployeeId = await insertEmployee("Legacy Plaintext", { address: MAIL_OLD });
  const inserted = await t.db
    .insert(changeRequests)
    .values({
      employeeId: migEmployeeId,
      requestType: "mailing_address",
      payload: MAIL_NEW,
      effectiveFrom: "2025-06-01",
      status: "approved",
      decidedBy: "legacy-admin",
      decidedAt: new Date("2025-05-20T00:00:00Z"),
      appliedAt: new Date("2025-05-20T00:00:00Z"),
    })
    .returning();
  const request = inserted[0];
  if (!request) throw new Error("change_request insert failed");
  await t.db.insert(auditEvents).values({
    actorId: "legacy-admin",
    action: "change_request.approve",
    entity: "change_request",
    entityId: request.publicId,
    before: { mailingAddress: MAIL_OLD },
    after: { applied: MAIL_NEW, effectiveFrom: "2025-06-01" },
  });
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Crypto helpers (pure)
// ---------------------------------------------------------------------------

describe("address crypto helpers", () => {
  it("round-trips an address payload through enc:v1: ciphertext", () => {
    const stored = encryptAddress(ADDR, UNIT_KEY);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain("Encryption Way");
    expect(decryptAddress(stored, UNIT_KEY)).toEqual(ADDR);
  });

  it("addressForStorage is idempotent and null-safe", () => {
    const stored = encryptAddress(ADDR, UNIT_KEY);
    expect(addressForStorage(stored, UNIT_KEY)).toBe(stored);
    expect(addressForStorage(ADDR, UNIT_KEY)).not.toBe(stored); // fresh IV
    expect(isAddressEncrypted(addressForStorage(ADDR, UNIT_KEY))).toBe(true);
    expect(addressForStorage(null, UNIT_KEY)).toBeNull();
    expect(addressForStorage(undefined, UNIT_KEY)).toBeNull();
  });

  it("decryptAddress tolerates legacy plaintext and rejects garbage", () => {
    expect(decryptAddress(ADDR, UNIT_KEY)).toEqual(ADDR); // legacy jsonb object
    expect(decryptAddress(JSON.stringify(ADDR), UNIT_KEY)).toEqual(ADDR); // legacy JSON string
    expect(decryptAddress("not json at all", UNIT_KEY)).toBeNull();
    expect(decryptAddress(42, UNIT_KEY)).toBeNull();
    expect(decryptAddress(null, UNIT_KEY)).toBeNull();
    expect(isAddressEncrypted(ADDR)).toBe(false);
    expect(isAddressEncrypted(JSON.stringify(ADDR))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API reads decrypt; the DB holds ciphertext
// ---------------------------------------------------------------------------

describe("admin directory + employee profile", () => {
  it("admin create stores ciphertext; create + detail responses decrypt", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/admin/employees",
      headers: ADMIN,
      payload: { legalName: "Enc Api", hireDate: "2025-01-01", address: ADDR },
    });
    expect(created.statusCode, created.body).toBe(201);
    const employeeId = (created.json() as { employee: { id: number; address: unknown } }).employee
      .id;
    expect((created.json() as { employee: { address: unknown } }).employee.address).toEqual(ADDR);

    const row = await rawEmployee(employeeId);
    expect(typeof row.address).toBe("string");
    expect(isAddressEncrypted(row.address)).toBe(true);

    const detail = await t.app.inject({
      method: "GET",
      url: `/api/admin/employees/${employeeId}`,
      headers: ADMIN,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as { employee: { address: unknown; mailingAddress: unknown } };
    expect(body.employee.address).toEqual(ADDR);
    expect(body.employee.mailingAddress).toBeNull();
  });

  it("/my/profile decrypts both address fields for the linked account", async () => {
    const row = await rawEmployee(selfEmployeeId);
    expect(isAddressEncrypted(row.address)).toBe(true);
    expect(isAddressEncrypted(row.mailingAddress)).toBe(true);

    const res = await t.app.inject({
      method: "GET",
      url: "/api/my/profile",
      headers: selfSession,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { profile } = res.json() as {
      profile: { address: unknown; mailingAddress: unknown };
    };
    expect(profile.address).toEqual(ADDR);
    expect(profile.mailingAddress).toEqual(MAIL_SELF);
  });
});

// ---------------------------------------------------------------------------
// Change-request flow — ciphertext at rest, decrypted reads, encrypted history
// ---------------------------------------------------------------------------

describe("address change request", () => {
  const effectiveFrom = nextMonthStart();
  let publicId = "";

  it("submit stores ciphertext; submit + list responses decrypt", async () => {
    const submitted = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: selfSession,
      payload: { requestType: "address", payload: ADDR_NEW, effectiveFrom },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const request = (submitted.json() as { request: { publicId: string; payload: unknown } })
      .request;
    publicId = request.publicId;
    expect(request.payload).toEqual(ADDR_NEW);

    const rows = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.payload).toBe("string");
    expect(isAddressEncrypted(rows[0]?.payload)).toBe(true);

    const list = await t.app.inject({
      method: "GET",
      url: "/api/change-requests",
      headers: selfSession,
    });
    expect(list.statusCode, list.body).toBe(200);
    const { requests } = list.json() as { requests: { publicId: string; payload: unknown }[] };
    expect(requests.find((r) => r.publicId === publicId)?.payload).toEqual(ADDR_NEW);
  });

  it("approve encrypts the employee row + audit snapshots; history resolves", async () => {
    const approved = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: ADMIN,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const row = await rawEmployee(selfEmployeeId);
    expect(isAddressEncrypted(row.address)).toBe(true);
    expect(decryptAddress(row.address, t.config.encryptionKey)).toEqual(ADDR_NEW);

    const audit = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "change_request.approve"),
          eq(auditEvents.entity, "change_request"),
          eq(auditEvents.entityId, publicId),
        ),
      );
    expect(audit).toHaveLength(1);
    const before = audit[0]?.before as { address: unknown } | null;
    const after = audit[0]?.after as { applied: unknown } | null;
    expect(isAddressEncrypted(before?.address)).toBe(true);
    expect(decryptAddress(before?.address, t.config.encryptionKey)).toEqual(ADDR);
    expect(isAddressEncrypted(after?.applied)).toBe(true);
    expect(decryptAddress(after?.applied, t.config.encryptionKey)).toEqual(ADDR_NEW);

    // As-of resolution reads ciphertext everywhere: the pre-change value comes
    // back from the encrypted audit `before`, the new one from the encrypted
    // history payload.
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        selfEmployeeId,
        "residential",
        dayBefore(effectiveFrom),
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(ADDR);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        selfEmployeeId,
        "residential",
        effectiveFrom,
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(ADDR_NEW);
  });
});

// ---------------------------------------------------------------------------
// In-place data migration
// ---------------------------------------------------------------------------

describe("encryptStoredAddresses migration", () => {
  it("rewrites plaintext rows in all three stores, idempotently", async () => {
    // Pre-migration: the legacy fixture is plaintext and still resolves.
    const preRow = await rawEmployee(migEmployeeId);
    expect(preRow.address).toEqual(MAIL_OLD);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        migEmployeeId,
        "mailing",
        "2025-06-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_NEW);

    const first = await encryptStoredAddresses({ db: t.db, config: t.config });
    // Only the legacy fixture was plaintext — everything above was born encrypted.
    expect(first.employeesUpdated).toBe(1);
    expect(first.requestsUpdated).toBe(1);
    expect(first.auditRowsUpdated).toBe(1);

    // Every store now holds ciphertext that decrypts to the original object.
    const row = await rawEmployee(migEmployeeId);
    expect(isAddressEncrypted(row.address)).toBe(true);
    expect(decryptAddress(row.address, t.config.encryptionKey)).toEqual(MAIL_OLD);

    const requestRows = await t.db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.employeeId, migEmployeeId),
          eq(changeRequests.requestType, "mailing_address"),
        ),
      );
    expect(requestRows).toHaveLength(1);
    expect(isAddressEncrypted(requestRows[0]?.payload)).toBe(true);
    expect(decryptAddress(requestRows[0]?.payload, t.config.encryptionKey)).toEqual(MAIL_NEW);

    const auditRows = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "change_request.approve"),
          eq(auditEvents.entity, "change_request"),
          eq(auditEvents.entityId, requestRows[0]!.publicId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const before = auditRows[0]?.before as { mailingAddress: unknown } | null;
    const after = auditRows[0]?.after as { applied: unknown } | null;
    expect(isAddressEncrypted(before?.mailingAddress)).toBe(true);
    expect(decryptAddress(before?.mailingAddress, t.config.encryptionKey)).toEqual(MAIL_OLD);
    expect(isAddressEncrypted(after?.applied)).toBe(true);
    expect(decryptAddress(after?.applied, t.config.encryptionKey)).toEqual(MAIL_NEW);

    // Resolution is unchanged by the migration — same objects out.
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        migEmployeeId,
        "mailing",
        "2025-05-31",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_OLD);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        migEmployeeId,
        "mailing",
        "2025-06-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_NEW);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        migEmployeeId,
        "residential",
        "2025-06-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_OLD);

    // Idempotent: a second run writes nothing.
    const second = await encryptStoredAddresses({ db: t.db, config: t.config });
    expect(second.employeesUpdated).toBe(0);
    expect(second.requestsUpdated).toBe(0);
    expect(second.auditRowsUpdated).toBe(0);
  });
});
