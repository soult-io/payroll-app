/**
 * New-device login detection (spec 6: security_login_new_device — always on).
 *
 * Fingerprint = SHA-256 of (user-agent + IP /24). Called from the auth
 * after-hook on a completed 2FA challenge (TOTP or backup code — a bare
 * password is never a full sign-in here). An unseen fingerprint inserts a
 * user_devices row and queues the security email; a seen one just bumps
 * last_seen_at.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { emailOutbox, userDevices } from "@payroll/db";
import { EVENT_TYPE, securityLoginNewDevice } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { companyName } from "./outbox.js";

/** IPv4 /24 or IPv6 /64 prefix — small ISP/DHCP drift shouldn't re-alert. */
export function ipPrefix(ip: string): string {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
  }
  // IPv6: first 4 hextets.
  const hextets = ip.split(":").filter((s) => s.length > 0);
  return hextets.length >= 4 ? `${hextets.slice(0, 4).join(":")}::/64` : ip;
}

export function deviceFingerprint(userAgent: string | null, ip: string | null): string {
  const basis = `${userAgent ?? "unknown-ua"}|${ip ? ipPrefix(ip) : "unknown-ip"}`;
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

/**
 * Record the device; queue security_login_new_device when the fingerprint is
 * new for this user. Returns true when the device was new.
 */
export async function trackDevice(
  deps: { db: Db; config: AppConfig },
  input: { userId: string; userAgent: string | null; ip: string | null },
): Promise<boolean> {
  const { db, config } = deps;
  const fingerprint = deviceFingerprint(input.userAgent, input.ip);

  const existing = await db
    .select({ fingerprint: userDevices.fingerprint })
    .from(userDevices)
    .where(and(eq(userDevices.userId, input.userId), eq(userDevices.fingerprint, fingerprint)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(userDevices)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(userDevices.userId, input.userId), eq(userDevices.fingerprint, fingerprint)));
    return false;
  }

  await db.insert(userDevices).values({ userId: input.userId, fingerprint });

  const rendered = securityLoginNewDevice(
    { companyName: await companyName(db), appUrl: config.baseUrl },
    { userAgent: input.userAgent, ip: input.ip, at: new Date().toISOString() },
  );
  await db.insert(emailOutbox).values({
    userId: input.userId,
    eventType: EVENT_TYPE.securityLoginNewDevice,
    subject: rendered.subject,
    bodyHtml: rendered.html,
  });
  return true;
}
