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
import {
  addDepositAttachment,
  listDepositAttachments,
  readDepositAttachment,
} from "../deposits/attachments.js";
import { MAX_ATTACHMENT_BYTES } from "../filings/attachments.js";

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

  app.get("/api/admin/tax-deposits", { preHandler: admin }, async (req, reply) => {
    // PAY-15: optional year/status filters, same shape as the payroll-runs list.
    const q = z
      .object({
        year: z.coerce.number().int().min(2020).max(2100).optional(),
        status: z.enum(["pending", "deposited", "overdue"]).optional(),
      })
      .safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    const deposits = await listDeposits(db, q.data);
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

  // ---------------------------------------------------------------------
  // PAY-27: deposit attachments (EFTPS confirmation/evidence PDFs). Raw-body
  // upload (application/pdf parser — no multipart dependency, registered in
  // the filings routes); admin-only read + write; bytes are AES-256-GCM
  // ciphertext at rest.
  // ---------------------------------------------------------------------

  if (!app.hasContentTypeParser("application/pdf")) {
    app.addContentTypeParser(
      "application/pdf",
      { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
      (_req, body, done) => done(null, body),
    );
  }

  app.get("/api/admin/tax-deposits/:id/attachments", { preHandler: admin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid_id" });
    try {
      return { attachments: await listDepositAttachments(db, id) };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/tax-deposits/:id/attachments", { preHandler: admin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid_id" });
    if (!Buffer.isBuffer(req.body)) {
      return reply
        .code(415)
        .send({ error: "unsupported_media_type", message: "POST the PDF as application/pdf" });
    }
    const q = z.object({ filename: z.string().max(300).optional() }).safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    try {
      const attachment = await addDepositAttachment(
        { db, config },
        id,
        { filename: q.data.filename ?? "confirmation.pdf", data: req.body },
        req.authUser!.id,
      );
      return reply.code(201).send({ attachment });
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.get(
    "/api/admin/tax-deposits/:id/attachments/:attachmentId/download",
    { preHandler: admin },
    async (req, reply) => {
      const params = req.params as { id: string; attachmentId: string };
      const id = Number(params.id);
      const attachmentId = Number(params.attachmentId);
      if (!Number.isInteger(id) || !Number.isInteger(attachmentId))
        return reply.code(400).send({ error: "invalid_id" });
      try {
        const { filename, data } = await readDepositAttachment(
          { db, config },
          id,
          attachmentId,
          req.authUser!.id,
        );
        return reply
          .header("content-type", "application/pdf")
          .header("content-disposition", `inline; filename="${filename.replaceAll('"', "_")}"`)
          .send(data);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );
}
