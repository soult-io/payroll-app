/**
 * Admin notification observability (spec 6 "Admin observability"): outbox
 * health (per-status counts + recent failures) and the "send test email"
 * button (queued through the outbox like everything else).
 */

import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { emailOutbox } from "@payroll/db";
import { adminTestEmail, EVENT_TYPE } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { companyName } from "../notify/outbox.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

export function registerAdminNotificationRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/notifications/outbox", { preHandler: admin }, async () => {
    const counts = await db
      .select({ status: emailOutbox.status, count: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .groupBy(emailOutbox.status);
    const recentFailures = await db
      .select({
        id: emailOutbox.id,
        userId: emailOutbox.userId,
        eventType: emailOutbox.eventType,
        subject: emailOutbox.subject,
        attempts: emailOutbox.attempts,
        lastError: emailOutbox.lastError,
        lastAttemptAt: emailOutbox.lastAttemptAt,
        createdAt: emailOutbox.createdAt,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "failed"))
      .orderBy(desc(emailOutbox.id))
      .limit(10);
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
      recentFailures,
      emailMode: config.emailMode,
      smtp: {
        configured: Boolean(config.smtp.host && config.smtp.from),
        host: config.smtp.host || null,
        port: config.smtp.port,
        from: config.smtp.from || null,
        secure: config.smtp.secure,
      },
    };
  });

  app.post("/api/admin/settings/test-email", { preHandler: admin }, async (req, reply) => {
    const rendered = adminTestEmail(
      { companyName: await companyName(db), appUrl: config.baseUrl },
      { by: req.authUser!.email },
    );
    await db.insert(emailOutbox).values({
      userId: req.authUser!.id,
      eventType: EVENT_TYPE.adminTestEmail,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
    return reply.code(202).send({ ok: true, queued: true });
  });
}
