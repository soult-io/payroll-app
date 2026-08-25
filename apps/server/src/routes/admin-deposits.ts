/**
 * Admin tax-deposit routes (PAY-9): the computed monthly deposit schedule
 * (list, newest period first), the record-only "mark as deposited" mutation
 * (EFTPS confirmation + date, audit-logged), and the admin-editable
 * reminder-offset schedule (D1). Record-only per D3 — the app never pays;
 * the admin pays on eftps.gov and records it here.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  DEFAULT_REMINDER_OFFSETS,
  DepositServiceError,
  getReminderOffsets,
  listDeposits,
  markDeposited,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MAX_ENTRIES,
  setReminderOffsets,
} from "../deposits/service.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const depositBody = z.object({
  depositedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "depositedOn must be YYYY-MM-DD"),
  eftpsConfirmation: z.string().trim().min(1).max(100),
});

const offsetsBody = z.object({
  offsets: z
    .array(z.number().int().min(0).max(REMINDER_OFFSET_MAX))
    .min(1)
    .max(REMINDER_OFFSET_MAX_ENTRIES),
});

function serviceError(
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  if (err instanceof DepositServiceError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerAdminDepositRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/tax-deposits", { preHandler: admin }, async () => {
    const deposits = await listDeposits(db);
    return { deposits };
  });

  app.post("/api/admin/tax-deposits/:id/deposit", { preHandler: admin }, async (req, reply) => {
    const body = depositBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid_id" });
    try {
      const deposit = await markDeposited(
        { db, config },
        id,
        { depositedOn: body.data.depositedOn, eftpsConfirmation: body.data.eftpsConfirmation },
        req.authUser!.id,
      );
      return { deposit };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.get("/api/admin/tax-deposits/reminder-schedule", { preHandler: admin }, async () => {
    const offsets = await getReminderOffsets(db);
    return { offsets, defaultOffsets: [...DEFAULT_REMINDER_OFFSETS] };
  });

  app.put(
    "/api/admin/tax-deposits/reminder-schedule",
    { preHandler: admin },
    async (req, reply) => {
      const body = offsetsBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      try {
        const offsets = await setReminderOffsets(
          { db, config },
          body.data.offsets,
          req.authUser!.id,
        );
        return { offsets };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );
}
