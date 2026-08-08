/**
 * Admin settings routes (frontend spec /admin/config + /admin/settings):
 * company profile (EIN masked on read) and the audit-log viewers
 * (auth_events + audit_events, paginated, newest first).
 */

import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, authEvents, company } from "@payroll/db";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { encryptField, maskLast4 } from "../crypto/field-encryption.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** IRS EIN format: XX-XXXXXXX (dash optional on input, normalized before storage). */
const einSchema = z.string().regex(/^\d{2}-?\d{7}$/, "ein must match XX-XXXXXXX");

function normalizeEin(ein: string): string {
  const digits = ein.replace("-", "");
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

export function registerAdminSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/company", { preHandler: admin }, async (_req, reply) => {
    const rows = await db.select().from(company).limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "no_company" });
    return {
      company: {
        id: row.id,
        legalName: row.legalName,
        einMasked: maskLast4(row.ein, config.encryptionKey),
        address: row.address,
      },
    };
  });

  app.put("/api/admin/company", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        legalName: z.string().trim().min(1).max(200),
        address: z
          .object({
            line1: z.string().min(1).max(200),
            line2: z.string().max(200).optional(),
            city: z.string().min(1).max(100),
            state: z.string().min(1).max(100),
            zip: z.string().min(1).max(20),
            country: z.string().min(2).max(2),
          })
          .optional(),
        // Spec 11 (D19): admin-editable EIN — encrypted at rest, write-only.
        ein: einSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(company).limit(1);
    const before = rows[0];
    if (!before) return reply.code(404).send({ error: "no_company" });

    const updated = await db
      .update(company)
      .set({
        legalName: body.data.legalName,
        ...(body.data.address !== undefined ? { address: body.data.address } : {}),
        ...(body.data.ein !== undefined
          ? { ein: encryptField(normalizeEin(body.data.ein), config.encryptionKey) }
          : {}),
      })
      .where(eq(company.id, before.id))
      .returning();
    // Audit records MASKED before/after only — the plaintext EIN never lands
    // in audit_events.
    const einChanged = body.data.ein !== undefined;
    await db.insert(auditEvents).values({
      actorId: req.authUser!.id,
      action: "company.update",
      entity: "company",
      entityId: String(before.id),
      before: {
        legalName: before.legalName,
        address: before.address,
        ...(einChanged ? { einMasked: maskLast4(before.ein, config.encryptionKey) } : {}),
      },
      after: {
        legalName: updated[0]!.legalName,
        address: updated[0]!.address,
        ...(einChanged ? { einMasked: maskLast4(updated[0]!.ein, config.encryptionKey) } : {}),
      },
    });
    return {
      company: {
        id: updated[0]!.id,
        legalName: updated[0]!.legalName,
        einMasked: maskLast4(updated[0]!.ein, config.encryptionKey),
        address: updated[0]!.address,
      },
    };
  });

  app.get("/api/admin/audit/auth-events", { preHandler: admin }, async (req) => {
    const q = pagination.parse(req.query);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(authEvents);
    const events = await db
      .select()
      .from(authEvents)
      .orderBy(desc(authEvents.id))
      .limit(q.limit)
      .offset(q.offset);
    // bigserial ids arrive as BigInt — JSON needs plain numbers.
    return {
      events: events.map((e) => ({ ...e, id: Number(e.id) })),
      total: countRow?.total ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/api/admin/audit/audit-events", { preHandler: admin }, async (req) => {
    const q = pagination.parse(req.query);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(auditEvents);
    const events = await db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.id))
      .limit(q.limit)
      .offset(q.offset);
    return {
      events: events.map((e) => ({ ...e, id: Number(e.id) })),
      total: countRow?.total ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });
}
