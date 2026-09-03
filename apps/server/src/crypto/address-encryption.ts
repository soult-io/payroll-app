/**
 * Address encryption (PAY-21) — field-level encryption at rest for employee
 * address payloads (employees.address / mailing_address, the address history
 * in change_requests.payload, and the pre-change snapshots in audit_events).
 *
 * Follows the tax_id/bank_details pattern (field-encryption.ts): AES-256-GCM
 * with the SECRETS_DIR key, self-describing "enc:v1:" format. Addresses are
 * JSON objects, so the WHOLE payload is encrypted (JSON.stringify →
 * encryptField) and the jsonb column holds the ciphertext string. Decryption
 * is plaintext-tolerant (legacy rows read as-is), exactly like decryptField.
 */

import type { AddressPayload } from "@payroll/shared";
import { decryptField, encryptField, isEncrypted } from "./field-encryption.js";

/** Encrypt one address payload for storage. */
export function encryptAddress(payload: AddressPayload, key: string): string {
  return encryptField(JSON.stringify(payload), key);
}

/**
 * Stored form for a write: null stays null, ciphertext passes through
 * unchanged (idempotent — legacy plaintext payloads landing on the target
 * field at approval time still get encrypted, same doctrine as bank_details).
 */
export function addressForStorage(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    // Already-encrypted → keep; a plaintext JSON string (shouldn't occur) → encrypt as-is.
    return isEncrypted(value) ? value : encryptField(value, key);
  }
  return encryptAddress(value as AddressPayload, key);
}

/** True when a stored value is ciphertext (migration idempotency check). */
export function isAddressEncrypted(value: unknown): boolean {
  return typeof value === "string" && isEncrypted(value);
}

/**
 * Read form for authorized server-side consumers (W-2/W-3 rendering, admin /
 * employee views, change-request resolution). Tolerates plaintext legacy
 * objects AND plaintext JSON strings; returns null for anything else.
 */
export function decryptAddress(value: unknown, key: string): AddressPayload | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const plain = isEncrypted(value) ? decryptField(value, key) : value;
    try {
      const parsed: unknown = JSON.parse(plain);
      return parsed && typeof parsed === "object" ? (parsed as AddressPayload) : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as AddressPayload; // plaintext legacy row
  return null;
}
