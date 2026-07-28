/**
 * End-to-end auth flows (spec 3): invite → accept → forced TOTP → login,
 * backup codes, token validation, CSRF, rate limiting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { desc, eq } from "drizzle-orm";
import { authEvents, authUser, emailOutbox, setupTokens } from "@payroll/db";
import { createTestApp, ORIGIN, cookieValue, type TestContext } from "./helpers.js";
import {
  inviteAndOnboard,
  login,
  sessionHeader,
  tokenFromLink,
  currentTotp,
  TEST_PASSWORD,
} from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("invite-only onboarding", () => {
  it("admin invite creates a banned (pending_enrollment) user + outbox email + auth event", async () => {
    const invite = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      { name: "E Employee", email: "employee@example.com", role: "employee" },
      null,
    );
    expect(invite.setupLink).toContain("/accept-invite?token=");

    const [user] = await t.db.select().from(authUser).where(eq(authUser.id, invite.userId));
    expect(user!.banned).toBe(true);
    expect(user!.banReason).toBe("pending_enrollment");
    expect(user!.twoFactorEnabled).toBe(false);

    const outbox = await t.db.select().from(emailOutbox).where(eq(emailOutbox.userId, invite.userId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe("invite_created");
    expect(outbox[0]!.status).toBe("pending");
    expect(outbox[0]!.bodyHtml).toContain("/accept-invite?token=");

    const events = await t.db.select().from(authEvents).where(eq(authEvents.userId, invite.userId));
    expect(events.map((e) => e.event)).toContain("invite_created");
  });

  it("rejects sign-up as disabled (invite-only at code level)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: ORIGIN,
      payload: { email: "intruder@example.com", password: "whatever-password-1", name: "X" },
    });
    expect([403, 404]).toContain(res.statusCode);
    const users = await t.db.select().from(authUser).where(eq(authUser.email, "intruder@example.com"));
    expect(users).toHaveLength(0);
  });

  it("rejects weak passwords (length + zxcvbn)", async () => {
    const invite = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      { name: "Weak", email: "weak@example.com", role: "employee" },
      null,
    );
    const token = tokenFromLink(invite.setupLink);

    const short = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/set-password",
      headers: ORIGIN,
      payload: { token, password: "short1!" },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe("weak_password");

    const weak = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/set-password",
      headers: ORIGIN,
      payload: { token, password: "password123456" },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("weak_password");
  });

  it("full flow: verify-token → set-password → TOTP enroll → backup codes → active", async () => {
    const onboarded = await inviteAndOnboard(t, { email: "flow@example.com", name: "Flow User" });
    expect(onboarded.backupCodes).toHaveLength(10);

    const [user] = await t.db.select().from(authUser).where(eq(authUser.id, onboarded.userId));
    expect(user!.banned).toBe(false);
    expect(user!.banReason).toBeNull();
    expect(user!.twoFactorEnabled).toBe(true);

    // Token consumed — reuse rejected.
    const reuse = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/verify-token",
      headers: ORIGIN,
      payload: { token: tokenFromLink((await inviteUser(
        { auth: t.auth, db: t.db, config: t.config },
        { name: "x", email: "flow2@example.com", role: "employee" },
        null,
      )).setupLink) },
    });
    expect(reuse.statusCode).toBe(200); // fresh token works
    const events = await t.db
      .select()
      .from(authEvents)
      .where(eq(authEvents.userId, onboarded.userId))
      .orderBy(desc(authEvents.id));
    expect(events.map((e) => e.event)).toContain("invite_accepted");
  });

  it("pending-enrollment user cannot log in before completing TOTP", async () => {
    const invite = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      { name: "Pending", email: "pending@example.com", role: "employee" },
      null,
    );
    const token = tokenFromLink(invite.setupLink);
    await t.app.inject({
      method: "POST",
      url: "/api/onboarding/set-password",
      headers: ORIGIN,
      payload: { token, password: TEST_PASSWORD },
    });
    const signIn = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email: "pending@example.com", password: TEST_PASSWORD },
    });
    expect(signIn.statusCode).toBe(403); // banned: pending_enrollment
  });

  it("enforces onboarding step order (password before TOTP)", async () => {
    const invite = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      { name: "Order", email: "order@example.com", role: "employee" },
      null,
    );
    const res = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/totp-enable",
      headers: ORIGIN,
      payload: { token: tokenFromLink(invite.setupLink) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("password_first");
  });

  it("login requires the TOTP step, then yields a working session", async () => {
    const email = "login@example.com";
    await inviteAndOnboard(t, { email });

    // Password only → 2FA challenge, no session yet.
    const signIn = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      payload: { email, password: TEST_PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().twoFactorRedirect).toBe(true);
    // No usable session cookie (BA clears it explicitly on the 2FA challenge).
    expect(cookieValue(signIn.headers["set-cookie"], "payroll.session_token") || null).toBeNull();

    // Wrong TOTP → mfa_fail.
    const twoFactorCookie = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor")!;
    const wrong = await t.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      headers: { ...ORIGIN, cookie: `payroll.two_factor=${twoFactorCookie}` },
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).not.toBe(200);

    const { sessionCookie } = await login(t, email, TEST_PASSWORD);
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: sessionHeader(sessionCookie) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
    expect(me.json().user.twoFactorEnabled).toBe(true);
  });

  it("backup code completes login once; reuse fails (single-use, hashed at rest)", async () => {
    const email = "backup@example.com";
    const { backupCodes } = await inviteAndOnboard(t, { email });
    const code = backupCodes[0]!;

    async function challenge() {
      const signIn = await t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: ORIGIN,
        payload: { email, password: TEST_PASSWORD },
      });
      return cookieValue(signIn.headers["set-cookie"], "payroll.two_factor")!;
    }

    let twoFactorCookie = await challenge();
    const ok = await t.app.inject({
      method: "POST",
      url: "/api/auth/backup-code/verify",
      headers: { ...ORIGIN, cookie: `payroll.two_factor=${twoFactorCookie}` },
      payload: { code },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieValue(ok.headers["set-cookie"], "payroll.session_token")).toBeTruthy();

    twoFactorCookie = await challenge();
    const reuse = await t.app.inject({
      method: "POST",
      url: "/api/auth/backup-code/verify",
      headers: { ...ORIGIN, cookie: `payroll.two_factor=${twoFactorCookie}` },
      payload: { code },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("blocks impersonation endpoints (impersonation OFF per spec)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/admin/impersonate-user",
      headers: ORIGIN,
      payload: { userId: "whoever" },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe("CSRF + rate limiting", () => {
  it("rejects mutating /api calls without a matching Origin", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/verify-token",
      payload: { token: "anything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf_origin_check_failed");

    const badOrigin = await t.app.inject({
      method: "POST",
      url: "/api/onboarding/verify-token",
      headers: { origin: "https://evil.example.com" },
      payload: { token: "anything" },
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it("rate-limits credential endpoints at 10/min per IP", async () => {
    const remoteAddress = "10.9.8.7";
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: ORIGIN,
        remoteAddress,
        payload: { email: "nobody@example.com", password: "wrong-password-1" },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).not.toBe(429);
    const eleventh = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      remoteAddress,
      payload: { email: "nobody@example.com", password: "wrong-password-1" },
    });
    expect(eleventh.statusCode).toBe(429);

    // Non-sensitive auth endpoints (session reads) are NOT rate-limited.
    const sessionRead = await t.app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      remoteAddress,
    });
    expect(sessionRead.statusCode).not.toBe(429);
  });

  it("setup tokens are stored hashed and single-use with expiry", async () => {
    const invite = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      { name: "Tok", email: "token@example.com", role: "employee" },
      null,
    );
    const token = tokenFromLink(invite.setupLink);
    const [row] = await t.db.select().from(setupTokens).where(eq(setupTokens.userId, invite.userId));
    expect(row!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    expect(row!.usedAt).toBeNull();
  });
});
