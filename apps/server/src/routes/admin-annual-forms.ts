/**
 * Admin annual-forms routes (PAY-11): per-employee W-2 list + on-demand W-2
 * PDFs, and the W-3 transmittal PDF. PDFs render from figures computed out
 * of frozen issued-run entries and are never stored (payslip/1099 doctrine).
 * The W-2 JSON list carries NO PII — SSN/address/EIN only ever enter the
 * rendered PDF, decrypted at render time. W-2s for a tax year unlock on
 * January 1 of the following year (the service enforces the gate).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { renderW2Pdf, renderW3Pdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  isW2Available,
  w2AvailableOn,
  w2FiguresForYear,
  w2InputFor,
  w3InputFor,
} from "../filings/annual.js";
import { FilingServiceError } from "../filings/shared.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const yearQuery = z.object({ year: z.coerce.number().int().min(2020).max(2100) });

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

export function registerAdminAnnualFormRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  /** Per-employee W-2 figures for the year (review list — figures, no PII). */
  app.get("/api/admin/annual-forms/w2", { preHandler: admin }, async (req, reply) => {
    const q = yearQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
    const figures = await w2FiguresForYear(db, q.data.year);
    return {
      year: q.data.year,
      available: isW2Available(q.data.year),
      availableOn: w2AvailableOn(q.data.year),
      w2s: figures,
    };
  });

  /** On-demand W-2 PDF for one employee (PII decrypted at render time only). */
  app.get(
    "/api/admin/annual-forms/w2/:employeeId/pdf",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const q = yearQuery.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
      try {
        const input = await w2InputFor({ db, config }, employeeId, q.data.year);
        const pdf = await renderW2Pdf(input);
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="w2-${q.data.year}-employee-${employeeId}.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  /** On-demand W-3 transmittal PDF for the year (admin-only). */
  app.get("/api/admin/annual-forms/w3/pdf", { preHandler: admin }, async (req, reply) => {
    const q = yearQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
    try {
      const input = await w3InputFor({ db, config }, q.data.year);
      const pdf = await renderW3Pdf(input);
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="w3-${q.data.year}.pdf"`)
        .send(pdf);
    } catch (err) {
      return serviceError(err, reply);
    }
  });
}
