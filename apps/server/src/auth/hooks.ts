/**
 * Better Auth hooks — auth_events audit (spec 3) + account lockout after 10
 * consecutive password failures (spec: "admin unlock or timed backoff"; we
 * implement admin unlock: the account is banned with reason 'lockout').
 */

import { createAuthMiddleware, APIError } from "better-auth/api";
import { and, desc, eq, or } from "drizzle-orm";
import { authEvents, authUser } from "@payroll/db";
import { writeAuthEvent, AUTH_EVENT, requestContext } from "./audit.js";
import type { Db } from "../db.js";

export const LOCKOUT_THRESHOLD = 10;

/** Count consecutive login_failure events since the last login_success for a user. */
async function consecutiveFailures(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ event: authEvents.event })
    .from(authEvents)
    .where(
      and(
        eq(authEvents.userId, userId),
        or(
          eq(authEvents.event, AUTH_EVENT.loginSuccess),
          eq(authEvents.event, AUTH_EVENT.loginFailure),
        ),
      ),
    )
    .orderBy(desc(authEvents.id))
    .limit(LOCKOUT_THRESHOLD + 1);
  let count = 0;
  for (const row of rows) {
    if (row.event === AUTH_EVENT.loginFailure) count++;
    else break;
  }
  return count;
}

async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email.toLowerCase()))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * after-hook: writes audit events for BA-owned flows and applies lockout.
 * Failure detection: BA's dispatcher catches endpoint APIErrors into
 * `ctx.context.returned` and still runs after-hooks (see dispatch.mjs).
 */
export function createAuditHook(deps: {
  db: Db;
  lockout: (userId: string, auditCtx: { ip?: string | null; userAgent?: string | null }) => Promise<void>;
}) {
  const { db } = deps;
  return createAuthMiddleware(async (ctx) => {
    const auditCtx = requestContext(ctx.headers ?? new Headers());
    const returned = ctx.context.returned;
    const isFailure = returned instanceof APIError;
    const sessionUser = (ctx.context.session?.user ?? null) as { id?: string; email?: string } | null;
    const body = (ctx.body ?? {}) as Record<string, unknown>;

    switch (ctx.path) {
      case "/sign-in/email": {
        const email = typeof body.email === "string" ? body.email : null;
        const userId = email ? await findUserIdByEmail(db, email) : null;
        if (isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.loginFailure, userId, auditCtx);
          // Only credential failures count toward lockout (not "user banned" etc.).
          const code = (returned as APIError).body?.code ?? "";
          if (userId && code === "INVALID_EMAIL_OR_PASSWORD") {
            if ((await consecutiveFailures(db, userId)) >= LOCKOUT_THRESHOLD) {
              await deps.lockout(userId, auditCtx);
            }
          }
        } else {
          await writeAuthEvent(db, AUTH_EVENT.loginSuccess, userId, auditCtx);
        }
        break;
      }
      case "/two-factor/verify-totp": {
        const returnedUser = (returned as { user?: { id?: string } } | undefined)?.user;
        const userId = sessionUser?.id ?? returnedUser?.id ?? null;
        await writeAuthEvent(db, isFailure ? AUTH_EVENT.mfaFail : AUTH_EVENT.mfaPass, userId, auditCtx);
        break;
      }
      case "/change-password": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.passwordChange, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/sign-out":
      case "/revoke-session":
      case "/revoke-sessions":
      case "/revoke-other-sessions": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.sessionRevoked, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/admin/set-role": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.roleChange, targetId, auditCtx);
        }
        break;
      }
      case "/admin/ban-user": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.userDisabled, targetId, auditCtx);
        }
        break;
      }
      case "/admin/unban-user": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.userEnabled, targetId, auditCtx);
        }
        break;
      }
      default:
        break;
    }
  });
}

/** Ban a user after lockout threshold and kill all sessions (spec: instant revocation). */
export async function lockoutUser(
  db: Db,
  internalAdapter: {
    updateUser: (id: string, data: Record<string, unknown>) => Promise<unknown>;
    deleteUserSessions: (id: string) => Promise<void>;
  },
  userId: string,
  auditCtx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await internalAdapter.updateUser(userId, { banned: true, banReason: "lockout" });
  await internalAdapter.deleteUserSessions(userId);
  await writeAuthEvent(db, AUTH_EVENT.lockout, userId, auditCtx);
  await writeAuthEvent(db, AUTH_EVENT.userDisabled, userId, auditCtx);
}
