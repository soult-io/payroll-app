/**
 * Employee payslip routes (spec documents API): own issued runs only —
 * 404 on foreign IDs (no enumeration), admin bypass for support flows.
 * PDFs render on demand from the frozen run_snapshot and are never stored.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { employees, payrollRuns } from "@payroll/db";
import { renderPayslipPdf, type PayslipSnapshot } from "@payroll/documents";
import type { Db } from "../db.js";
import type { Guards } from "../plugins/guards.js";
import { getRunByPublicId, type RunRow } from "../payroll/runs.js";

interface PayslipDeps {
  db: Db;
  guards: Guards;
}

function publicView(run: RunRow) {
  const snapshot = run.runSnapshot as PayslipSnapshot;
  return {
    publicId: run.publicId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDate: run.payDate,
    status: run.status,
    grossPay: snapshot.result.grossPay,
    netPay: snapshot.result.netPay,
    snapshotHash: run.snapshotHash,
    issuedAt: run.issuedAt,
  };
}

async function resolveEmployee(db: Db, userId: string) {
  const rows = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export function registerPayslipRoutes(app: FastifyInstance, deps: PayslipDeps): void {
  const { db, guards } = deps;

  /**
   * Employee-self-or-admin access check. Employees resolve their employees
   * row and may only see their own runs (404 otherwise); admins pass.
   */
  async function canAccess(req: FastifyRequest, run: RunRow): Promise<boolean> {
    if (req.authUser?.role === "admin") return true;
    const employee = await resolveEmployee(db, req.authUser!.id);
    return employee?.id === run.employeeId;
  }

  app.get("/api/payslips", { preHandler: guards.requireAuth }, async (req) => {
    if (req.authUser?.role === "admin") {
      const rows = await db
        .select()
        .from(payrollRuns)
        .where(eq(payrollRuns.status, "issued"))
        .orderBy(desc(payrollRuns.periodStart));
      return { payslips: rows.map(publicView) };
    }
    const employee = await resolveEmployee(db, req.authUser!.id);
    if (!employee) return { payslips: [] };
    const rows = await db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.employeeId, employee.id), eq(payrollRuns.status, "issued")))
      .orderBy(desc(payrollRuns.periodStart));
    return { payslips: rows.map(publicView) };
  });

  app.get("/api/payslips/:publicId", { preHandler: guards.requireAuth }, async (req, reply) => {
    const { publicId } = req.params as { publicId: string };
    const run = await getRunByPublicId(db, publicId);
    if (run?.status !== "issued") return reply.code(404).send({ error: "not_found" });
    if (!(await canAccess(req, run))) return reply.code(404).send({ error: "not_found" });
    return { payslip: { ...publicView(run), snapshot: run.runSnapshot } };
  });

  app.get("/api/payslips/:publicId/pdf", { preHandler: guards.requireAuth }, async (req, reply) => {
    const { publicId } = req.params as { publicId: string };
    const run = await getRunByPublicId(db, publicId);
    if (run?.status !== "issued") return reply.code(404).send({ error: "not_found" });
    if (!(await canAccess(req, run))) return reply.code(404).send({ error: "not_found" });

    const pdf = await renderPayslipPdf(run.runSnapshot as PayslipSnapshot);
    const month = run.periodStart.slice(0, 7); // payslip-YYYY-MM.pdf (deterministic)
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="payslip-${month}.pdf"`)
      .send(pdf);
  });
}
