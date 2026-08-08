/**
 * Backup codes (spec 3): 10 single-use codes at TOTP enrollment, shown once,
 * HASHED at rest (SHA-256). Better Auth's built-in backup-code storage is
 * plain/encrypted-reversible, so we store our own hashes in the twoFactor
 * table's backupCodes column (BA's own /two-factor/verify-backup-code path is
 * disabled) and verify via this plugin's /backup-code/verify endpoint, which
 * completes the pending 2FA login exactly like BA's TOTP verify does.
 */

import { createHash, randomInt } from "node:crypto";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie, expireCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { writeAuthEvent, AUTH_EVENT, requestContext, type Db } from "./audit-deps.js";

const TWO_FACTOR_COOKIE_NAME = "two_factor";
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 10; j++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function normalizeBackupCode(code: string): string {
  return code.trim().toLowerCase().replace(/-/g, "");
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

/** Serialize a set of code hashes for the twoFactor.backupCodes column. */
export function encodeCodeHashes(codes: string[]): string {
  return JSON.stringify(codes.map(hashBackupCode));
}

export function decodeCodeHashes(stored: unknown): string[] {
  if (typeof stored !== "string" || stored.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface BackupCodePluginDeps {
  db: Db;
}

export const payrollBackupCodes = (deps: BackupCodePluginDeps) =>
  ({
    id: "payroll-backup-codes",
    endpoints: {
      verifyBackupCode: createAuthEndpoint(
        "/backup-code/verify",
        { method: "POST" },
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear auth guard chain; splitting adds indirection without behavior gain
        async (ctx) => {
          const auditCtx = requestContext(ctx.headers ?? new Headers());
          const code = typeof ctx.body?.code === "string" ? ctx.body.code : "";
          if (!normalizeBackupCode(code)) {
            throw new APIError("BAD_REQUEST", { message: "code is required" });
          }

          // Pending-2FA cookie → verification value → user (mirrors BA verifyTwoFactor).
          const twoFactorCookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
          const signed = await ctx.getSignedCookie(twoFactorCookie.name, ctx.context.secret);
          if (!signed) {
            throw new APIError("UNAUTHORIZED", { message: "INVALID_TWO_FACTOR_COOKIE" });
          }
          const verification = await ctx.context.internalAdapter.findVerificationValue(signed);
          if (!verification) {
            throw new APIError("UNAUTHORIZED", { message: "INVALID_TWO_FACTOR_COOKIE" });
          }
          const user = await ctx.context.internalAdapter.findUserById(verification.value);
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: "INVALID_TWO_FACTOR_COOKIE" });
          }

          const twoFactor = await ctx.context.adapter.findOne<{
            id: string;
            userId: string;
            backupCodes: string;
          }>({
            model: "twoFactor",
            where: [{ field: "userId", value: user.id }],
          });
          const hashes = decodeCodeHashes(twoFactor?.backupCodes);
          const presented = hashBackupCode(code);
          if (!twoFactor || !hashes.includes(presented)) {
            await writeAuthEvent(deps.db, AUTH_EVENT.mfaFail, user.id, auditCtx);
            throw new APIError("UNAUTHORIZED", { message: "INVALID_CODE" });
          }

          // Single-use: remove the presented hash before completing login.
          const remaining = hashes.filter((h) => h !== presented);
          await ctx.context.adapter.update({
            model: "twoFactor",
            update: { backupCodes: JSON.stringify(remaining) },
            where: [{ field: "id", value: twoFactor.id }],
          });

          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(signed);
          if (!consumed || consumed.value !== user.id) {
            expireCookie(ctx, twoFactorCookie);
            throw new APIError("UNAUTHORIZED", { message: "INVALID_TWO_FACTOR_COOKIE" });
          }
          const session = await ctx.context.internalAdapter.createSession(consumed.value);
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "FAILED_TO_CREATE_SESSION" });
          }
          await setSessionCookie(ctx, { session, user });
          expireCookie(ctx, twoFactorCookie);
          await writeAuthEvent(deps.db, AUTH_EVENT.mfaPass, user.id, auditCtx);
          return ctx.json({
            token: session.token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: (user as Record<string, unknown>).role ?? "employee",
            },
          });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
