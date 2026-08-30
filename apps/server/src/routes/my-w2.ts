/**
 * Employee W-2 routes (PAY-11): the employee's own annual W-2, available
 * from January 1 of the following year. List + on-demand PDF — same
 * generated-not-stored doctrine as payslips. Employees see only their own
 * W-2 (the employees row is resolved from the session user; foreign years
 * or locked years 404/409 without enumeration).
 */

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import { renderW2Pdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { listMyW2Years, w2AvailableOn, w2InputFor } from "../filings/annual.js";
import { FilingServiceError } from "../filings/shared.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

export function registerMyW2Routes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;

  app.get("/api/my/w2", { preHandler: guards.requireAuth }, async (req) => {
    const years = await listMyW2Years(db, req.authUser!.id);
    return { w2s: years.map((year) => ({ year, availableOn: w2AvailableOn(year) })) };
  });

  app.get("/api/my/w2/:year/pdf", { preHandler: guards.requireAuth }, async (req, reply) => {
    const year = Number((req.params as { year: string }).year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      return reply.code(400).send({ error: "invalid_year" });
    }
    const employeeRows = await db
      .select()
      .from(employees)
      .where(and(eq(employees.userId, req.authUser!.id), eq(employees.employmentType, "w2")))
      .limit(1);
    const employee = employeeRows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    try {
      const input = await w2InputFor({ db, config }, employee.id, year);
      const pdf = await renderW2Pdf(input);
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="w2-${year}.pdf"`)
        .send(pdf);
    } catch (err) {
      if (err instanceof FilingServiceError) {
        const status = err.code === "not_found" ? 404 : 409;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
