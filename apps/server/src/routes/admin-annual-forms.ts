/**
 * Admin annual-forms routes (PAY-11 + PAY-19): per-employee W-2 list +
 * on-demand W-2 PDFs, and the W-3 transmittal PDF. PDFs render from figures
 * computed out of frozen issued-run entries and are never stored
 * (payslip/1099 doctrine). The W-2 JSON list carries NO PII — SSN/address/
 * EIN only ever enter the rendered PDF, decrypted at render time. W-2s for
 * a tax year unlock on January 1 of the following year (the service
 * enforces the gate).
 *
 * PAY-19 (D1/D4): the per-employee PDF is the official Copy D (employer
 * records); the print packet (Copies B/C/2 + IRS instructions) exists so
 * the admin can physically furnish W-2s to employees who have NOT consented
 * to electronic delivery — the list rows carry a `consented` flag for that.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { renderW2AdminCopyD, renderW2EmployeePacket, renderW3Pdf } from "@payroll/documents";
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
import { w2ConsentFlags } from "../filings/w2-consent.js";
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
    const consent = await w2ConsentFlags(
      db,
      figures.map((f) => f.employeeId),
    );
    return {
      year: q.data.year,
      available: isW2Available(q.data.year),
      availableOn: w2AvailableOn(q.data.year),
      w2s: figures.map((f) => ({ ...f, consented: consent.get(f.employeeId) ?? false })),
    };
  });

  /** Copy D for one employee (employer records; PII at render time only). */
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
        const pdf = await renderW2AdminCopyD(input);
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="w2-${q.data.year}-employee-${employeeId}-copy-d.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  /**
   * Print-ready employee packet (Copies B/C/2 + IRS instructions) for one
   * employee — the physical-furnishing route for employees who have not
   * consented to electronic delivery (D4). Consent-independent.
   */
  app.get(
    "/api/admin/annual-forms/w2/:employeeId/print-packet",
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
        const pdf = await renderW2EmployeePacket(input);
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="w2-${q.data.year}-employee-${employeeId}-print-packet.pdf"`,
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
