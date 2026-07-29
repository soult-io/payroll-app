/**
 * Session management (spec 3): multiple sessions, list/revoke, absolute 7d
 * expiry, idle 12h enforced by requireAuth, ban kills sessions instantly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authSession } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let ipCounter = 0;
/** Distinct IP per login: sensitive /api/auth/* paths share one 10/min bucket per IP. */
function nextIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

/** The session cookie is `token.signature` — the DB stores the raw token. */
function rawToken(sessionCookie: string): string {
  return sessionCookie.split(".")[0]!;
}

async function sessionsOf(userId: string) {
  return t.db.select().from(authSession).where(eq(authSession.userId, userId));
}

async function me(cookie: string) {
  return t.app.inject({ method: "GET", url: "/api/me", headers: sessionHeader(cookie) });
}

describe("session lifecycle", () => {
  it("supports concurrent sessions, list-sessions, and revoke-session", async () => {
    const email = "multi@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const first = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    const second = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    expect(first.sessionCookie).not.toBe(second.sessionCookie);

    const list = await t.app.inject({
      method: "GET",
      url: "/api/auth/list-sessions",
      headers: sessionHeader(first.sessionCookie),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(2);

    // Revoke the OTHER session via its raw token.
    const rows = await sessionsOf(userId);
    expect(rows.length).toBe(2);
    const otherToken = rows.find((r) => r.token !== rawToken(first.sessionCookie))!.token;
    const revoke = await t.app.inject({
      method: "POST",
      url: "/api/auth/revoke-session",
      headers: sessionHeader(first.sessionCookie),
      payload: { token: otherToken },
    });
    expect(revoke.statusCode).toBe(200);

    expect((await me(second.sessionCookie)).statusCode).toBe(401);
    expect((await me(first.sessionCookie)).statusCode).toBe(200);

    // revoke-sessions kills everything, including the current one.
    const revive = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    const revokeAll = await t.app.inject({
      method: "POST",
      url: "/api/auth/revoke-sessions",
      headers: sessionHeader(revive.sessionCookie),
      payload: {},
    });
    expect(revokeAll.statusCode).toBe(200);
    expect((await me(revive.sessionCookie)).statusCode).toBe(401);
    expect((await sessionsOf(userId)).length).toBe(0);
  });

  it("expires absolutely after 7 days (no sliding refresh)", async () => {
    const email = "absolute@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    const [session] = await sessionsOf(userId);
    const lifetimeMs =
      new Date(session!.expiresAt).getTime() - new Date(session!.createdAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(lifetimeMs - sevenDaysMs)).toBeLessThan(60 * 1000);
  });

  it("revokes sessions idle for more than 12 hours", async () => {
    const email = "idle@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });

    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    await t.db
      .update(authSession)
      .set({ updatedAt: thirteenHoursAgo })
      .where(eq(authSession.userId, userId));

    const res = await me(sessionCookie);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_expired");
    // The stale session row is deleted (revocation, not just rejection).
    expect((await sessionsOf(userId)).length).toBe(0);
  });

  it("touches updatedAt on activity (throttled) without extending expiry", async () => {
    const email = "touch@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });

    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await t.db
      .update(authSession)
      .set({ updatedAt: twoMinutesAgo })
      .where(eq(authSession.userId, userId));

    const res = await me(sessionCookie);
    expect(res.statusCode).toBe(200);

    const [session] = await sessionsOf(userId);
    expect(new Date(session!.updatedAt).getTime()).toBeGreaterThan(twoMinutesAgo.getTime());
    // Absolute expiry untouched by activity.
    const lifetimeMs =
      new Date(session!.expiresAt).getTime() - new Date(session!.createdAt).getTime();
    expect(Math.abs(lifetimeMs - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(60 * 1000);
  });

  it("banning a user kills all sessions instantly", async () => {
    await inviteAndOnboard(t, { email: "ban-admin@example.com", role: "admin" });
    const admin = await login(t, "ban-admin@example.com", TEST_PASSWORD, {
      remoteAddress: nextIp(),
    });

    const email = "ban-victim@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const victim = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    expect((await me(victim.sessionCookie)).statusCode).toBe(200);

    const ban = await t.app.inject({
      method: "POST",
      url: "/api/auth/admin/ban-user",
      headers: sessionHeader(admin.sessionCookie),
      payload: { userId, banReason: "admin_action" },
    });
    expect(ban.statusCode).toBe(200);

    expect((await sessionsOf(userId)).length).toBe(0);
    expect((await me(victim.sessionCookie)).statusCode).toBe(401);
  });
});
