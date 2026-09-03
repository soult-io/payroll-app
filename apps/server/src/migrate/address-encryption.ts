/**
 * PAY-21 data migration — encrypt existing employee address data in place.
 *
 * Drizzle SQL migrations cannot AES-encrypt (the key lives in SECRETS_DIR),
 * so this is a code migration in the ytd-backfill/paydate-fix tradition: a
 * transactional walk that rewrites every plaintext address payload as
 * "enc:v1:" ciphertext:
 *
 *   1. employees.address / employees.mailing_address (current values)
 *   2. change_requests.payload for address/mailing_address requests (the
 *      effective-dated history — pending AND approved rows)
 *   3. audit_events before/after of the corresponding change_request.approve
 *      events (the pre-change snapshot address-history.ts resolves from)
 *
 * Idempotent: ciphertext is skipped (isAddressEncrypted), so a re-run writes
 * nothing. Plaintext-tolerant readers (decryptAddress) mean the app works
 * before, during, and after the migration. One summary audit row records the
 * run itself.
 */

import { and, eq, inArray } from "drizzle-orm";
import { auditEvents, changeRequests, employees } from "@payroll/db";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  addressForStorage,
  decryptAddress,
  isAddressEncrypted,
} from "../crypto/address-encryption.js";

export const ADDRESS_ENCRYPTION_ACTOR = "cli:encrypt-addresses";

export interface AddressEncryptionReport {
  employeesScanned: number;
  employeesUpdated: number;
  requestsScanned: number;
  requestsUpdated: number;
  auditRowsScanned: number;
  auditRowsUpdated: number;
}

const ADDRESS_REQUEST_TYPES = ["address", "mailing_address"] as const;

/**
 * Encrypt one audit before/after block in place-ish: before carries
 * { address } / { mailingAddress }; after carries { applied }. Values that
 * are null or already ciphertext pass through.
 */
function encryptAuditBlock(block: unknown, key: string): { next: unknown; changed: boolean } {
  if (!block || typeof block !== "object") return { next: block, changed: false };
  const record = { ...(block as Record<string, unknown>) };
  let changed = false;
  for (const field of ["address", "mailingAddress", "applied"] as const) {
    const value = record[field];
    if (value === null || value === undefined || isAddressEncrypted(value)) continue;
    // Only encrypt values that actually look like an address payload.
    if (decryptAddress(value, key) === null) continue;
    record[field] = addressForStorage(value, key);
    changed = true;
  }
  return { next: changed ? record : block, changed };
}

export async function encryptStoredAddresses(
  deps: { db: Db; config: AppConfig },
  opts: { log?: (line: string) => void } = {},
): Promise<AddressEncryptionReport> {
  const { db, config } = deps;
  const key = config.encryptionKey;
  const log = opts.log ?? (() => {});
  const report: AddressEncryptionReport = {
    employeesScanned: 0,
    employeesUpdated: 0,
    requestsScanned: 0,
    requestsUpdated: 0,
    auditRowsScanned: 0,
    auditRowsUpdated: 0,
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear three-store transactional walk — reads top-to-bottom deliberately, same doctrine as migrate.ts
  await db.transaction(async (tx) => {
    // 1. employees current values.
    const employeeRows = await tx
      .select({
        id: employees.id,
        address: employees.address,
        mailingAddress: employees.mailingAddress,
      })
      .from(employees);
    report.employeesScanned = employeeRows.length;
    for (const row of employeeRows) {
      const set: { address?: string | null; mailingAddress?: string | null } = {};
      if (row.address !== null && !isAddressEncrypted(row.address)) {
        set.address = addressForStorage(row.address, key);
      }
      if (row.mailingAddress !== null && !isAddressEncrypted(row.mailingAddress)) {
        set.mailingAddress = addressForStorage(row.mailingAddress, key);
      }
      if (Object.keys(set).length === 0) continue;
      await tx.update(employees).set(set).where(eq(employees.id, row.id));
      report.employeesUpdated += 1;
    }
    log(`employees: ${report.employeesUpdated}/${report.employeesScanned} row(s) encrypted`);

    // 2. change_requests payloads (the effective-dated history).
    const requestRows = await tx
      .select({
        id: changeRequests.id,
        publicId: changeRequests.publicId,
        payload: changeRequests.payload,
      })
      .from(changeRequests)
      .where(inArray(changeRequests.requestType, [...ADDRESS_REQUEST_TYPES]));
    report.requestsScanned = requestRows.length;
    for (const row of requestRows) {
      if (isAddressEncrypted(row.payload)) continue;
      await tx
        .update(changeRequests)
        .set({ payload: addressForStorage(row.payload, key) })
        .where(eq(changeRequests.id, row.id));
      report.requestsUpdated += 1;
    }
    log(
      `change_requests: ${report.requestsUpdated}/${report.requestsScanned} payload(s) encrypted`,
    );

    // 3. audit before/after snapshots of those requests' approve events.
    const publicIds = requestRows.map((r) => r.publicId);
    if (publicIds.length > 0) {
      const auditRows = await tx
        .select({ id: auditEvents.id, before: auditEvents.before, after: auditEvents.after })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "change_request.approve"),
            eq(auditEvents.entity, "change_request"),
            inArray(auditEvents.entityId, publicIds),
          ),
        );
      report.auditRowsScanned = auditRows.length;
      for (const row of auditRows) {
        const before = encryptAuditBlock(row.before, key);
        const after = encryptAuditBlock(row.after, key);
        if (!before.changed && !after.changed) continue;
        await tx
          .update(auditEvents)
          .set({ before: before.next, after: after.next })
          .where(eq(auditEvents.id, row.id));
        report.auditRowsUpdated += 1;
      }
    }
    log(`audit_events: ${report.auditRowsUpdated}/${report.auditRowsScanned} row(s) encrypted`);

    await tx.insert(auditEvents).values({
      actorId: ADDRESS_ENCRYPTION_ACTOR,
      action: "data.encrypt_addresses",
      entity: "schema",
      entityId: "pay-21",
      before: null,
      after: { ...report },
    });
  });

  log("address encryption committed");
  return report;
}
