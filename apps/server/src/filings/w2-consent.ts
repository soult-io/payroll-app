/**
 * W-2 electronic-delivery consent (PAY-19, D4 — Pub 1141 §2.4): an employee
 * must affirmatively consent before their W-2 PDF is served electronically.
 * Consent is one row per employee, blanket across tax years until withdrawn;
 * withdrawal re-gates the download. The paper route never closes — the admin
 * prints the employee packet for anyone not consented.
 *
 * Pub 1141 §2.4 required disclosures (furnished before consent, versioned):
 * the right to a paper copy and how to get one, the scope/duration of the
 * consent, how to withdraw and the consequences, the hardware/software
 * requirement (a PDF reader), and the posting window (on or before Jan 31,
 * retained through at least Oct 15).
 */

import { eq, inArray } from "drizzle-orm";
import { auditEvents, w2DeliveryConsents } from "@payroll/db";
import type { Db } from "../db.js";
import { FilingServiceError } from "./shared.js";

/** Version of the disclosure text below — bumped when the wording changes. */
export const W2_DISCLOSURE_VERSION = "2025-01";

/** The exact disclosure bullets shown before the consent button (D4). */
export const W2_DISCLOSURES: readonly string[] = [
  "By consenting, you agree to receive your Form W-2 electronically through this portal instead of as a paper copy.",
  "You may still request a paper copy of any W-2 at any time by asking your payroll administrator; a paper copy will be provided at no charge.",
  "Your consent applies to every future tax year's W-2 until you withdraw it.",
  "You may withdraw your consent at any time on this page. Withdrawal takes effect immediately: future W-2s will be furnished on paper.",
  "To view and print your electronic W-2 you need a device with a PDF reader.",
  "Your W-2 for a tax year will be available on or before January 31 of the following year and remains accessible here through at least October 15 of that year.",
];

export interface W2ConsentStatus {
  consented: boolean;
  consentedAt: string | null;
  withdrawnAt: string | null;
  disclosureVersion: string;
  disclosures: readonly string[];
}

/** Current consent state for one employee (PII-free). */
export async function w2ConsentStatus(db: Db, employeeId: number): Promise<W2ConsentStatus> {
  const rows = await db
    .select()
    .from(w2DeliveryConsents)
    .where(eq(w2DeliveryConsents.employeeId, employeeId))
    .limit(1);
  const row = rows[0];
  return {
    consented: row !== undefined && row.withdrawnAt === null,
    consentedAt: row?.consentedAt.toISOString() ?? null,
    withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
    disclosureVersion: row?.disclosureVersion ?? W2_DISCLOSURE_VERSION,
    disclosures: W2_DISCLOSURES,
  };
}

/**
 * Record (or renew after withdrawal) the employee's electronic-delivery
 * consent. Idempotent when already consented. Audited.
 */
export async function consentToElectronicW2(
  db: Db,
  employeeId: number,
  actorId: string,
): Promise<W2ConsentStatus> {
  const before = await w2ConsentStatus(db, employeeId);
  if (!before.consented) {
    const now = new Date();
    await db
      .insert(w2DeliveryConsents)
      .values({
        employeeId,
        disclosureVersion: W2_DISCLOSURE_VERSION,
        consentedAt: now,
        withdrawnAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [w2DeliveryConsents.employeeId],
        set: {
          disclosureVersion: W2_DISCLOSURE_VERSION,
          consentedAt: now,
          withdrawnAt: null,
          updatedAt: now,
        },
      });
    await db.insert(auditEvents).values({
      actorId,
      action: "w2_consent.consent",
      entity: "w2_consent",
      entityId: String(employeeId),
      before: { consented: before.consented, withdrawnAt: before.withdrawnAt },
      after: { consented: true, disclosureVersion: W2_DISCLOSURE_VERSION },
    });
  }
  return w2ConsentStatus(db, employeeId);
}

/**
 * Withdraw consent — future W-2s go back to paper and the electronic
 * download re-gates. Audited. Throws not_found when nothing was ever
 * consented; idempotent when already withdrawn.
 */
export async function withdrawW2Consent(
  db: Db,
  employeeId: number,
  actorId: string,
): Promise<W2ConsentStatus> {
  const before = await w2ConsentStatus(db, employeeId);
  if (before.consentedAt === null) {
    throw new FilingServiceError("not_found", "no W-2 electronic-delivery consent on file");
  }
  if (before.consented) {
    const now = new Date();
    await db
      .update(w2DeliveryConsents)
      .set({ withdrawnAt: now, updatedAt: now })
      .where(eq(w2DeliveryConsents.employeeId, employeeId));
    await db.insert(auditEvents).values({
      actorId,
      action: "w2_consent.withdraw",
      entity: "w2_consent",
      entityId: String(employeeId),
      before: { consented: true, disclosureVersion: before.disclosureVersion },
      after: { consented: false },
    });
  }
  return w2ConsentStatus(db, employeeId);
}

/** Active-consent flags for a set of employees (admin list — no timestamps). */
export async function w2ConsentFlags(db: Db, employeeIds: number[]): Promise<Map<number, boolean>> {
  const flags = new Map<number, boolean>(employeeIds.map((id) => [id, false]));
  if (employeeIds.length === 0) return flags;
  const rows = await db
    .select()
    .from(w2DeliveryConsents)
    .where(inArray(w2DeliveryConsents.employeeId, employeeIds));
  for (const row of rows) {
    if (flags.has(row.employeeId)) flags.set(row.employeeId, row.withdrawnAt === null);
  }
  return flags;
}
