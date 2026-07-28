/**
 * Invite & reset machinery (spec 3 "Invite-only registration").
 * Shared by the admin routes and the create-admin CLI.
 */

import { eq } from "drizzle-orm";
import { auditEvents, authUser, emailOutbox } from "@payroll/db";
import type { Auth } from "./auth.js";
import type { Db } from "../db.js";
import { smtpConfigured, type AppConfig } from "../config.js";
import { createSetupToken, revokeOutstandingSetupTokens, type SetupTokenPurpose } from "./tokens.js";
import { writeAuthEvent, AUTH_EVENT, type AuthEventContext } from "./audit.js";

export interface UserServiceDeps {
  auth: Auth;
  db: Db;
  config: AppConfig;
}

export interface InviteResult {
  userId: string;
  email: string;
  setupLink: string;
  /** True when SMTP is not configured and the link must be copied manually. */
  smtpMissing: boolean;
}

function setupLink(config: AppConfig, purpose: SetupTokenPurpose, token: string): string {
  const path = purpose === "invite" ? "/accept-invite" : "/reset-password";
  return `${config.baseUrl}${path}?token=${token}`;
}

/** Queue the setup email (outbox pattern — actual SMTP sending lands in step 4). */
async function queueSetupEmail(
  db: Db,
  userId: string,
  purpose: SetupTokenPurpose,
  link: string,
): Promise<void> {
  const subject =
    purpose === "invite" ? "You're invited to Payroll" : "Payroll password reset";
  await db.insert(emailOutbox).values({
    userId,
    eventType: purpose === "invite" ? "invite_created" : "password_reset",
    subject,
    bodyHtml: `<p>Use this single-use link within 24 hours to ${
      purpose === "invite" ? "set up your account" : "reset your password"
    }:</p><p><a href="${link}">${link}</a></p>`,
  });
}

/**
 * Invite a new user: creates the BA user (banned pending enrollment), a setup
 * token, and the outbox email. Returns the setup link (manual-copy SMTP
 * fallback, spec 3). No credential account exists yet — it is created at
 * invite acceptance (set-password), which doubles as the onboarding
 * step-order marker (TOTP enrollment requires the account to exist).
 */
export async function inviteUser(
  deps: UserServiceDeps,
  input: { name: string; email: string; role: "admin" | "employee" },
  actorId: string | null,
  auditCtx: AuthEventContext = {},
): Promise<InviteResult> {
  const { auth, db, config } = deps;
  const email = input.email.trim().toLowerCase();
  const existing = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email)).limit(1);
  if (existing.length > 0) {
    throw new UserServiceError("email_exists", `a user with email ${email} already exists`);
  }

  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    name: input.name.trim(),
    email,
    emailVerified: true, // email ownership is proven by acting on the invite link
    role: input.role,
    banned: true,
    banReason: "pending_enrollment",
  });

  await revokeOutstandingSetupTokens(db, user.id);
  const { token } = await createSetupToken(db, user.id, "invite");
  const link = setupLink(config, "invite", token);
  await queueSetupEmail(db, user.id, "invite", link);
  await writeAuthEvent(db, AUTH_EVENT.inviteCreated, user.id, auditCtx);
  if (actorId) {
    await db.insert(auditEvents).values({
      actorId,
      action: "user.invite",
      entity: "user",
      entityId: user.id,
      before: null,
      after: { email, name: input.name, role: input.role },
    });
  }
  return { userId: user.id, email, setupLink: link, smtpMissing: !smtpConfigured(config) };
}

/**
 * Admin-initiated password reset (spec: recovery = backup code, else admin
 * reset + re-enrollment). Bans the user (pending re-enrollment), kills all
 * sessions, wipes TOTP, and issues a reset token.
 */
export async function initiateReset(
  deps: UserServiceDeps,
  userId: string,
  actorId: string | null,
  auditCtx: AuthEventContext = {},
): Promise<InviteResult> {
  const { auth, db, config } = deps;
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user) throw new UserServiceError("not_found", "user not found");

  await ctx.internalAdapter.updateUser(userId, {
    banned: true,
    banReason: "pending_enrollment",
    twoFactorEnabled: false,
  });
  await ctx.internalAdapter.deleteUserSessions(userId);
  await ctx.adapter.deleteMany({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });

  await revokeOutstandingSetupTokens(db, userId);
  const { token } = await createSetupToken(db, userId, "reset");
  const link = setupLink(config, "reset", token);
  await queueSetupEmail(db, userId, "reset", link);
  if (actorId) {
    await db.insert(auditEvents).values({
      actorId,
      action: "user.reset_initiated",
      entity: "user",
      entityId: userId,
      before: null,
      after: null,
    });
  }
  return { userId, email: user.email, setupLink: link, smtpMissing: !smtpConfigured(config) };
}

/** Admin unlock after lockout (spec: lockout → admin unlock). */
export async function unlockUser(
  deps: UserServiceDeps,
  userId: string,
  actorId: string | null,
  auditCtx: AuthEventContext = {},
): Promise<void> {
  const { auth, db } = deps;
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user) throw new UserServiceError("not_found", "user not found");
  await ctx.internalAdapter.updateUser(userId, { banned: false, banReason: null });
  await writeAuthEvent(db, AUTH_EVENT.userEnabled, userId, auditCtx);
  if (actorId) {
    await db.insert(auditEvents).values({
      actorId,
      action: "user.unlock",
      entity: "user",
      entityId: userId,
      before: { banned: true },
      after: { banned: false },
    });
  }
}

export class UserServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
