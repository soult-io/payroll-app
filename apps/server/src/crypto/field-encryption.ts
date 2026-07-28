/**
 * Field-level encryption at rest (spec data-model cross-cutting): AES-256-GCM
 * with the SECRETS_DIR-mounted key, for bank_details / tax_id / company.ein.
 * Format: "enc:v1:<base64url(iv|tag|ciphertext)>" — self-describing, so
 * plaintext legacy rows remain readable (decryptField passes them through).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keyBytes(key: string): Buffer {
  // Any-length secret → 32-byte key (documented dev fallback is 64 hex chars;
  // hashing normalizes both).
  return createHash("sha256").update(key, "utf8").digest();
}

export function encryptField(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

export function decryptField(value: string, key: string): string {
  if (!value.startsWith(PREFIX)) return value; // plaintext legacy tolerance
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** "••••1234" — decrypts when needed, tolerates plaintext, never throws on shape. */
export function maskLast4(value: string | null | undefined, key: string): string | null {
  if (!value) return null;
  try {
    const plain = decryptField(value, key);
    return `••••${plain.slice(-4)}`;
  } catch {
    return "••••????";
  }
}
