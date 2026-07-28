/**
 * Shared flow helpers for integration tests: invite+onboard a user through the
 * real HTTP endpoints, and log in (password + TOTP) capturing the session cookie.
 */

import { eq } from "drizzle-orm";
import { authTwoFactor } from "@payroll/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import type { TestContext } from "./helpers.js";
import { ORIGIN, cookieValue } from "./helpers.js";
import { inviteUser } from "../src/auth/users.js";

export const TEST_PASSWORD = "correct-horse-battery-staple-9";

export function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get("token")!;
}

/** Current TOTP code for a user, derived from the encrypted secret in the DB. */
export async function currentTotp(t: TestContext, userId: string): Promise<string> {
  const rows = await t.db.select().from(authTwoFactor).where(eq(authTwoFactor.userId, userId)).limit(1);
  if (!rows[0]) throw new Error("no twoFactor row");
  const ctx = await t.auth.$context;
  const secret = await symmetricDecrypt({ key: ctx.secretConfig, data: rows[0].secret });
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

export interface OnboardedUser {
  userId: string;
  email: string;
  backupCodes: string[];
}

/** Invite (direct service call) + full onboarding via HTTP endpoints. */
export async function inviteAndOnboard(
  t: TestContext,
  input: { email: string; name?: string; role?: "admin" | "employee"; password?: string },
): Promise<OnboardedUser> {
  const invite = await inviteUser(
    { auth: t.auth, db: t.db, config: t.config },
    { name: input.name ?? input.email.split("@")[0]!, email: input.email, role: input.role ?? "employee" },
    null,
  );
  const token = tokenFromLink(invite.setupLink);

  const verify = await t.app.inject({
    method: "POST",
    url: "/api/onboarding/verify-token",
    headers: ORIGIN,
    payload: { token },
  });
  if (verify.statusCode !== 200) throw new Error(`verify-token failed: ${verify.body}`);

  const setPw = await t.app.inject({
    method: "POST",
    url: "/api/onboarding/set-password",
    headers: ORIGIN,
    payload: { token, password: input.password ?? TEST_PASSWORD },
  });
  if (setPw.statusCode !== 200) throw new Error(`set-password failed: ${setPw.body}`);

  const enable = await t.app.inject({
    method: "POST",
    url: "/api/onboarding/totp-enable",
    headers: ORIGIN,
    payload: { token },
  });
  if (enable.statusCode !== 200) throw new Error(`totp-enable failed: ${enable.body}`);
  const { totpURI } = enable.json() as { totpURI: string };
  if (!totpURI.startsWith("otpauth://totp/")) throw new Error("bad totp URI");

  const code = await currentTotp(t, invite.userId);
  const verifyTotp = await t.app.inject({
    method: "POST",
    url: "/api/onboarding/totp-verify",
    headers: ORIGIN,
    payload: { token, code },
  });
  if (verifyTotp.statusCode !== 200) throw new Error(`totp-verify failed: ${verifyTotp.body}`);
  const { backupCodes } = verifyTotp.json() as { backupCodes: string[] };

  return { userId: invite.userId, email: invite.email, backupCodes };
}

export interface LoginResult {
  sessionCookie: string;
  userId: string;
}

/** Full login: password (2FA challenge) + TOTP verify → session cookie value. */
export async function login(
  t: TestContext,
  email: string,
  password: string,
  extra: { remoteAddress?: string } = {},
): Promise<LoginResult> {
  // remoteAddress alone is invisible to Better Auth (it reads proxy headers);
  // mirror production (NPM) by also setting x-forwarded-for.
  const ipHeaders = extra.remoteAddress ? { "x-forwarded-for": extra.remoteAddress } : {};
  const signIn = await t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { ...ORIGIN, ...ipHeaders },
    remoteAddress: extra.remoteAddress,
    payload: { email, password },
  });
  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in failed (${signIn.statusCode}): ${signIn.body}`);
  }
  const signInBody = signIn.json() as Record<string, unknown>;
  const twoFactorCookie = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
  if (signInBody.twoFactorRedirect !== true || !twoFactorCookie) {
    throw new Error(`expected 2FA challenge, got: ${signIn.body}`);
  }

  const me = await t.app.inject({ method: "GET", url: "/api/auth/get-session" });
  void me; // session must NOT exist yet at this point (checked in flows test)

  const userId = await userIdByEmail(t, email);
  const code = await currentTotp(t, userId);
  const verify = await t.app.inject({
    method: "POST",
    url: "/api/auth/two-factor/verify-totp",
    headers: { ...ORIGIN, ...ipHeaders, cookie: `payroll.two_factor=${twoFactorCookie}` },
    remoteAddress: extra.remoteAddress,
    payload: { code },
  });
  if (verify.statusCode !== 200) {
    throw new Error(`verify-totp failed (${verify.statusCode}): ${verify.body}`);
  }
  const sessionCookie = cookieValue(verify.headers["set-cookie"], "payroll.session_token");
  if (!sessionCookie) throw new Error("no session cookie after 2FA verify");
  return { sessionCookie, userId };
}

export async function userIdByEmail(t: TestContext, email: string): Promise<string> {
  const { authUser } = await import("@payroll/db");
  const rows = await t.db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email)).limit(1);
  if (!rows[0]) throw new Error(`user ${email} not found`);
  return rows[0].id;
}

export function sessionHeader(cookie: string) {
  return { ...ORIGIN, cookie: `payroll.session_token=${cookie}` };
}
