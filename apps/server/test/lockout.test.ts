/**
 * Account lockout (spec 3): 10 consecutive password failures → account banned
 * (reason "lockout") + sessions killed; only admin unlock restores access.
 * Only INVALID_EMAIL_OR_PASSWORD failures count; a success resets the streak.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authEvents, authUser } from "@payroll/db";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, TEST_PASSWORD } from "./flow-helpers.js";
import { LOCKOUT_THRESHOLD } from "../src/auth/hooks.js";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let ipCounter = 0;
/** Distinct IP per request so the 10/min rate limit never interferes. */
function nextIp(): string {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

async function failedSignIn(email: string): Promise<number> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: ORIGIN,
    remoteAddress: nextIp(),
    payload: { email, password: "wrong-password-12345" },
  });
  return res.statusCode;
}

describe("account lockout", () => {
  it("locks the account after 10 consecutive failures; admin unlock restores it", async () => {
    const email = "lockout@example.com";
    const { userId } = await inviteAndOnboard(t, { email });

    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      expect(await failedSignIn(email)).toBe(401);
    }
    // Not yet locked: correct credentials still reach the 2FA challenge.
    const before = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      remoteAddress: nextIp(),
      payload: { email, password: TEST_PASSWORD },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().twoFactorRedirect).toBe(true);

    // The success above resets the streak, so burn a fresh full streak.
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect(await failedSignIn(email)).toBe(401);
    }

    // Locked: correct password is now rejected with 403 (banned).
    const after = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: ORIGIN,
      remoteAddress: nextIp(),
      payload: { email, password: TEST_PASSWORD },
    });
    expect(after.statusCode).toBe(403);

    const [user] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
    expect(user!.banned).toBe(true);
    expect(user!.banReason).toBe("lockout");

    const events = await t.db
      .select({ event: authEvents.event })
      .from(authEvents)
      .where(eq(authEvents.userId, userId));
    expect(events.some((e) => e.event === "lockout")).toBe(true);
    expect(events.filter((e) => e.event === "login_failure").length).toBeGreaterThanOrEqual(
      LOCKOUT_THRESHOLD,
    );

    // Admin unlock (spec: lockout → admin unlock).
    await inviteAndOnboard(t, { email: "lockout-admin@example.com", role: "admin" });
    const { sessionCookie } = await login(t, "lockout-admin@example.com", TEST_PASSWORD);
    const unlock = await t.app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/unlock`,
      headers: { ...ORIGIN, cookie: `payroll.session_token=${sessionCookie}` },
    });
    expect(unlock.statusCode).toBe(200);

    const [unlocked] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
    expect(unlocked!.banned).toBe(false);

    // Login works again after unlock.
    const again = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    expect(again.sessionCookie).toBeTruthy();
  });

  it("only consecutive failures count — a success resets the streak", async () => {
    const email = "streak@example.com";
    await inviteAndOnboard(t, { email });

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        expect(await failedSignIn(email)).toBe(401);
      }
      // A successful password check (2FA challenge) breaks the streak.
      const ok = await t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: ORIGIN,
        remoteAddress: nextIp(),
        payload: { email, password: TEST_PASSWORD },
      });
      expect(ok.statusCode).toBe(200);
    }

    // Two streaks of 9 with successes between → still not locked.
    const { userId } = await login(t, email, TEST_PASSWORD, { remoteAddress: nextIp() });
    const [user] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
    expect(user!.banned).toBe(false);
  });
});
