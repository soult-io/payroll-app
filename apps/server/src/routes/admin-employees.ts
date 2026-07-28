/**
 * Admin employee-directory routes (frontend spec /admin/employees): list,
 * detail (with linked user), create, invite-or-resend (links the user to the
 * employee record), and disable/enable (employee status + auth ban stay in
 * sync). Every mutation writes audit_events.
 */

import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, authUser, company, employees } from "@payroll/db";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { inviteUser, resendInvite, UserServiceError } from "../auth/users.js";
import { requestContext } from "../auth/audit.js";
import { toHeaders } from "../plugins/guards.js";
import { encryptField } from "../crypto/field-encryption.js";

interface Deps {
  auth: Auth;
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  zip: z.string().min(1).max(20),
  country: z.string().min(2).max(2),
});

export function registerAdminEmployeeRoutes(app: FastifyInstance, deps: Deps): void {
  const { auth, db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  async function audit(actorId: string, action: string, entityId: string, before: unknown, after: unknown) {
    await db.insert(auditEvents).values({ actorId, action, entity: "employee", entityId, before, after });
  }

  async function employeeWithUser(employeeId: number) {
    const rows = await db
      .select({
        employee: employees,
        userEmail: authUser.email,
        userBanned: authUser.banned,
        userBanReason: authUser.banReason,
      })
      .from(employees)
      .leftJoin(authUser, eq(authUser.id, employees.userId))
      .where(eq(employees.id, employeeId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { employee, userEmail, userBanned, userBanReason } = row;
    // tax_id and bank_details never leave the server through the directory API.
    const { taxId: _taxId, bankDetails: _bankDetails, ...safeEmployee } = employee;
    return {
      ...safeEmployee,
      user: employee.userId
        ? { id: employee.userId, email: userEmail, banned: userBanned, banReason: userBanReason }
        : null,
    };
  }

  app.get("/api/admin/employees", { preHandler: admin }, async () => {
    const rows = await db
      .select({
        id: employees.id,
        userId: employees.userId,
        legalName: employees.legalName,
        preferredName: employees.preferredName,
        employmentType: employees.employmentType,
        hireDate: employees.hireDate,
        terminationDate: employees.terminationDate,
        status: employees.status,
        userEmail: authUser.email,
        userBanned: authUser.banned,
      })
      .from(employees)
      .leftJoin(authUser, eq(authUser.id, employees.userId))
      .orderBy(employees.legalName);
    return { employees: rows };
  });

  app.get("/api/admin/employees/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const detail = await employeeWithUser(employeeId);
    if (!detail) return reply.code(404).send({ error: "not_found" });
    return { employee: detail };
  });

  app.post("/api/admin/employees", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        legalName: z.string().trim().min(1).max(200),
        preferredName: z.string().trim().max(200).optional(),
        employmentType: z.enum(["w2", "1099"]).default("w2"),
        hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        address: addressSchema.optional(),
        taxId: z.string().regex(/^\d{9}$/, "tax id must be 9 digits").optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const companyRows = await db.select({ id: company.id }).from(company).limit(1);
    const companyRow = companyRows[0];
    if (!companyRow) return reply.code(409).send({ error: "no_company", message: "company row missing — run seeds" });

    const inserted = await db
      .insert(employees)
      .values({
        companyId: companyRow.id,
        legalName: body.data.legalName,
        preferredName: body.data.preferredName ?? null,
        employmentType: body.data.employmentType,
        hireDate: body.data.hireDate,
        address: body.data.address ?? null,
        // SSN is encrypted at rest the moment it enters the system.
        taxId: body.data.taxId ? encryptField(body.data.taxId, config.encryptionKey) : null,
      })
      .returning();
    const row = inserted[0]!;
    await audit(req.authUser!.id, "employee.create", String(row.id), null, {
      legalName: row.legalName,
      employmentType: row.employmentType,
      hireDate: row.hireDate,
    });
    return reply.code(201).send({ employee: await employeeWithUser(row.id) });
  });

  /**
   * Invite the employee's user and link the records, or resend the invite
   * when the linked user never completed onboarding.
   */
  app.post("/api/admin/employees/:employeeId/invite", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    const auditCtx = requestContext(toHeaders(req));

    try {
      if (employee.userId) {
        // Linked already — only a resend makes sense, and only pre-enrollment.
        const result = await resendInvite(deps, employee.userId, req.authUser!.id, auditCtx);
        return { ...result, resent: true };
      }
      const body = z
        .object({
          email: z.string().email().max(320),
          name: z.string().trim().min(1).max(200).default(employee.legalName),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

      const result = await inviteUser(deps, { name: body.data.name, email: body.data.email, role: "employee" }, req.authUser!.id, auditCtx);
      await db.update(employees).set({ userId: result.userId, updatedAt: new Date() }).where(eq(employees.id, employeeId));
      await audit(req.authUser!.id, "employee.link_user", String(employeeId), { userId: null }, { userId: result.userId });
      return reply.code(201).send({ ...result, resent: false });
    } catch (err) {
      if (err instanceof UserServiceError) {
        const status = err.code === "email_exists" ? 409 : err.code === "not_pending_enrollment" ? 409 : 404;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /** Disable (terminate + ban linked user) or re-enable. */
  app.post("/api/admin/employees/:employeeId/status", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        status: z.enum(["active", "terminated"]),
        terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    if (employee.status === body.data.status) {
      return reply.code(409).send({ error: "no_op", message: `employee is already '${employee.status}'` });
    }

    const terminating = body.data.status === "terminated";
    const updated = await db
      .update(employees)
      .set({
        status: body.data.status,
        terminationDate: terminating ? (body.data.terminationDate ?? new Date().toISOString().slice(0, 10)) : null,
        updatedAt: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

    // Auth stays in sync: terminated employees lose access immediately.
    if (employee.userId) {
      const ctx = await auth.$context;
      if (terminating) {
        await ctx.internalAdapter.updateUser(employee.userId, { banned: true, banReason: "employee_terminated" });
        await ctx.internalAdapter.deleteUserSessions(employee.userId);
      } else {
        await ctx.internalAdapter.updateUser(employee.userId, { banned: false, banReason: null });
      }
    }

    await audit(
      req.authUser!.id,
      terminating ? "employee.disable" : "employee.enable",
      String(employeeId),
      { status: employee.status },
      { status: updated[0]!.status, terminationDate: updated[0]!.terminationDate },
    );
    return { employee: await employeeWithUser(employeeId) };
  });
}
