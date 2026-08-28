/**
 * Admin tax-filing routes (PAY-10): quarterly Form 941 — the computed
 * worksheet (line-by-line, frozen snapshot + hash), filing-status tracking
 * (mark-as-filed with method + reference, e.g. the Letterstream Job ID),
 * the admin-editable line-7 fractions-of-cents (D4), first-class
 * adjustment/notice records per filing (D3 — the CP220 lesson), and the
 * admin-editable reminder-offset schedule (D1). Record-only per D2 — the
 * app never files; the admin files by mail/e-file and records it here.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  addAdjustment,
  DEFAULT_FILING_REMINDER_OFFSETS,
  deleteAdjustment,
  FILING_REMINDER_OFFSET_MAX,
  FILING_REMINDER_OFFSET_MAX_ENTRIES,
  FilingServiceError,
  getFilingDetail,
  getFilingReminderOffsets,
  listFilings,
  markFiled,
  setFilingReminderOffsets,
  setFractionsOfCents,
  updateAdjustment,
} from "../filings/service.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^-?\d{1,10}(\.\d{1,2})?$/;
const NONNEG_MONEY = /^\d{1,10}(\.\d{1,2})?$/;

const filedBody = z.object({
  filedOn: z.string().regex(ISO_DATE, "filedOn must be YYYY-MM-DD"),
  filingMethod: z.string().trim().min(1).max(50),
  filingReference: z.string().trim().max(100).default(""),
});

const fractionsBody = z.object({
  amount: z.string().regex(MONEY, "amount must be a decimal, e.g. 0.01 or -0.02"),
});

const adjustmentBody = z.object({
  kind: z.string().trim().min(1).max(50),
  noticeDate: z.string().regex(ISO_DATE).optional().or(z.literal("")),
  amountDue: z.string().regex(NONNEG_MONEY, "amountDue must be a non-negative decimal"),
  abatedAmount: z.string().regex(NONNEG_MONEY).optional(),
  amountPaid: z.string().regex(NONNEG_MONEY).optional(),
  paidOn: z.string().regex(ISO_DATE).optional().or(z.literal("")),
  eftpsConfirmation: z.string().trim().max(100).optional(),
  note: z.string().max(2000).optional(),
});

const offsetsBody = z.object({
  offsets: z
    .array(z.number().int().min(0).max(FILING_REMINDER_OFFSET_MAX))
    .min(1)
    .max(FILING_REMINDER_OFFSET_MAX_ENTRIES),
});

function serviceError(
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  if (err instanceof FilingServiceError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

function intParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerAdminFilingRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/tax-filings", { preHandler: admin }, async (req, reply) => {
    const q = z
      .object({
        year: z.coerce.number().int().min(2020).max(2100).optional(),
        status: z.enum(["not_started", "ready", "filed"]).optional(),
        formType: z.enum(["941", "940", "w2_w3"]).optional(),
      })
      .safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    const filings = await listFilings(db, q.data);
    return { filings };
  });

  app.get("/api/admin/tax-filings/:id", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      return await getFilingDetail(db, id);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/tax-filings/:id/file", { preHandler: admin }, async (req, reply) => {
    const body = filedBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const filing = await markFiled({ db, config }, id, body.data, req.authUser!.id);
      return { filing };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.put(
    "/api/admin/tax-filings/:id/fractions-of-cents",
    { preHandler: admin },
    async (req, reply) => {
      const body = fractionsBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      const id = intParam((req.params as { id: string }).id);
      if (!id) return reply.code(400).send({ error: "invalid_id" });
      try {
        const filing = await setFractionsOfCents(
          { db, config },
          id,
          body.data.amount,
          req.authUser!.id,
        );
        return { filing };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.post("/api/admin/tax-filings/:id/adjustments", { preHandler: admin }, async (req, reply) => {
    const body = adjustmentBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const adjustment = await addAdjustment({ db, config }, id, body.data, req.authUser!.id);
      return reply.code(201).send({ adjustment });
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.put(
    "/api/admin/tax-filings/:id/adjustments/:adjId",
    { preHandler: admin },
    async (req, reply) => {
      const body = adjustmentBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      const params = req.params as { id: string; adjId: string };
      const id = intParam(params.id);
      const adjId = intParam(params.adjId);
      if (!id || !adjId) return reply.code(400).send({ error: "invalid_id" });
      try {
        const adjustment = await updateAdjustment(
          { db, config },
          id,
          adjId,
          body.data,
          req.authUser!.id,
        );
        return { adjustment };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.delete(
    "/api/admin/tax-filings/:id/adjustments/:adjId",
    { preHandler: admin },
    async (req, reply) => {
      const params = req.params as { id: string; adjId: string };
      const id = intParam(params.id);
      const adjId = intParam(params.adjId);
      if (!id || !adjId) return reply.code(400).send({ error: "invalid_id" });
      try {
        await deleteAdjustment({ db, config }, id, adjId, req.authUser!.id);
        return { ok: true };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.get("/api/admin/tax-filings/reminder-schedule", { preHandler: admin }, async () => {
    const offsets = await getFilingReminderOffsets(db);
    return { offsets, defaultOffsets: [...DEFAULT_FILING_REMINDER_OFFSETS] };
  });

  app.put("/api/admin/tax-filings/reminder-schedule", { preHandler: admin }, async (req, reply) => {
    const body = offsetsBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const offsets = await setFilingReminderOffsets(
        { db, config },
        body.data.offsets,
        req.authUser!.id,
      );
      return { offsets };
    } catch (err) {
      return serviceError(err, reply);
    }
  });
}
