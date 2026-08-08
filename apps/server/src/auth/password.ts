/**
 * Password hashing — Argon2id with OWASP parameters (spec 3):
 * m=19 MiB (19456 KiB), t=2, p=1. Wired into Better Auth via custom
 * password.hash/verify hooks (BA defaults to scrypt).
 */

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

const OWASP_ARGON2ID = {
  memoryCost: 19_456, // 19 MiB, in KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, OWASP_ARGON2ID);
}

export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  try {
    return await argonVerify(data.hash, data.password, OWASP_ARGON2ID);
  } catch {
    // Malformed stored hash — treat as mismatch, never throw into auth flow.
    return false;
  }
}

/** Password policy (spec 3): min 12 chars + zxcvbn strength check. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MIN_ZXCVBN_SCORE = 3;
