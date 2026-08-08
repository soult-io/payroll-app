/**
 * Notification plumbing (spec 6): queueing helpers that render templates, and
 * the outbox drain worker (pg-boss calls it; tests drive it directly with a
 * stub TRANSPORT — the DB is never stubbed).
 *
 * Drain semantics: pending rows eligible by exponential backoff
 * (2^attempts minutes since last_attempt_at); workflow events the user opted
 * out of are marked 'suppressed'; security events bypass settings; 5 attempts
 * → 'failed' + last_error. Dev mode ('log') logs instead of sending.
 */

import { and, asc, eq } from "drizzle-orm";
import { company, emailOutbox, notificationSettings } from "@payroll/db";
import { WORKFLOW_EVENTS } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";

/** Minimal nodemailer-compatible transport (structural — stubbed in tests). */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

export const MAX_ATTEMPTS = 5;

/** Backoff: 2^attempts minutes after the last attempt (1, 2, 4, 8, 16…). */
function backoffMs(attempts: number): number {
  return 2 ** attempts * 60 * 1000;
}

export interface DrainResult {
  sent: number;
  suppressed: number;
  failed: number;
  retriedLater: number;
  logged: number;
}

export interface DrainDeps {
  db: Db;
  config: AppConfig;
  /** Required when config.emailMode === 'smtp'; ignored in 'log' mode. */
  transport?: MailTransport;
  /** Resolve recipient email address from user id. */
  resolveRecipientEmail: (userId: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

/**
 * Drain eligible outbox rows. Idempotent and safe to run on any cadence —
 * ineligible rows are left pending for a later tick.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: outbox drain loop; per-row branches are the domain logic
export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const { db, config } = deps;
  const result: DrainResult = { sent: 0, suppressed: 0, failed: 0, retriedLater: 0, logged: 0 };
  const log = deps.log ?? (() => {});

  const pending = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.status, "pending"))
    .orderBy(asc(emailOutbox.id));

  for (const row of pending) {
    // Exponential backoff: not yet eligible.
    if (row.attempts > 0 && row.lastAttemptAt) {
      const eligibleAt = row.lastAttemptAt.getTime() + backoffMs(row.attempts);
      if (Date.now() < eligibleAt) {
        result.retriedLater += 1;
        continue;
      }
    }

    // Workflow events respect notification_settings; security events bypass.
    if ((WORKFLOW_EVENTS as readonly string[]).includes(row.eventType)) {
      const settings = await db
        .select()
        .from(notificationSettings)
        .where(
          and(
            eq(notificationSettings.userId, row.userId),
            eq(notificationSettings.eventType, row.eventType),
          ),
        )
        .limit(1);
      if (settings[0] && !settings[0].enabled) {
        await db
          .update(emailOutbox)
          .set({ status: "suppressed" })
          .where(eq(emailOutbox.id, row.id));
        result.suppressed += 1;
        continue;
      }
    }

    if (config.emailMode === "log") {
      log(`[email:dev-log] to user ${row.userId} — ${row.subject}`);
      await db
        .update(emailOutbox)
        .set({ status: "sent", sentAt: new Date(), attempts: row.attempts + 1 })
        .where(eq(emailOutbox.id, row.id));
      result.logged += 1;
      continue;
    }

    try {
      if (!deps.transport) throw new Error("no mail transport configured");
      const to = await deps.resolveRecipientEmail(row.userId);
      if (!to) throw new Error(`no email address for user ${row.userId}`);
      await deps.transport.sendMail({
        from: config.smtp.from,
        to,
        subject: row.subject,
        html: row.bodyHtml,
        text: htmlToText(row.bodyHtml),
      });
      await db
        .update(emailOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          attempts: row.attempts + 1,
          lastAttemptAt: new Date(),
        })
        .where(eq(emailOutbox.id, row.id));
      result.sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(emailOutbox)
        .set({
          attempts,
          lastError: message,
          lastAttemptAt: new Date(),
          ...(attempts >= MAX_ATTEMPTS ? { status: "failed" } : {}),
        })
        .where(eq(emailOutbox.id, row.id));
      result.failed += 1;
    }
  }
  return result;
}

/** text/plain fallback for rows queued before the template refactor stored html only. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Company-name helper for template contexts (single company row per spec 1). */
export async function companyName(db: Pick<Db, "select">): Promise<string> {
  const rows = await db.select({ legalName: company.legalName }).from(company).limit(1);
  return rows[0]?.legalName ?? "Payroll";
}
