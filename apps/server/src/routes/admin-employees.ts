/**
 * Admin employee-directory routes (frontend spec /admin/employees): list,
 * detail (with linked user), create, invite-or-resend (links the user to the
 * employee record), and disable/enable (employee status + auth ban stay in
 * sync). Every mutation writes audit_events.
 */

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, authUser, changeRequests, company, employees } from "@payroll/db";
import { isoDate } from "@payroll/shared";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { inviteUser, resendInvite, UserServiceError } from "../auth/users.js";
import { requestContext } from "../auth/audit.js";
import { toHeaders } from "../plugins/guards.js";
import { encryptField, maskLast4 } from "../crypto/field-encryption.js";
import { addressForStorage, decryptAddress, encryptAddress } from "../crypto/address-encryption.js";

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

  async function audit(
    actorId: string,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    await db
      .insert(auditEvents)
      .values({ actorId, action, entity: "employee", entityId, before, after });
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
      // PAY-21: addresses are ciphertext at rest; authorized admin reads get
      // the decrypted object (decryptAddress tolerates plaintext legacy rows).
      address: decryptAddress(employee.address, config.encryptionKey),
      mailingAddress: decryptAddress(employee.mailingAddress, config.encryptionKey),
      // Presence flag only (spec 11 D20a) — the masked value stays server-side.
      hasTaxId: Boolean(employee.taxId),
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
        taxId: z
          .string()
          .regex(/^\d{9}$/, "tax id must be 9 digits")
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const companyRows = await db.select({ id: company.id }).from(company).limit(1);
    const companyRow = companyRows[0];
    if (!companyRow)
      return reply
        .code(409)
        .send({ error: "no_company", message: "company row missing — run seeds" });

    const inserted = await db
      .insert(employees)
      .values({
        companyId: companyRow.id,
        legalName: body.data.legalName,
        preferredName: body.data.preferredName ?? null,
        employmentType: body.data.employmentType,
        hireDate: body.data.hireDate,
        address: body.data.address ? encryptAddress(body.data.address, config.encryptionKey) : null,
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
   * Spec 11 (D20a): admin direct-set of the employee TIN for backfill/
   * corrections. Same validation + encryption as the create path; write-only
   * (the directory API never returns the value, masked or otherwise) and the
   * audit event carries masked before/after only.
   *
   * PAY-20: the same endpoint also accepts `mailingAddress` (+ optional
   * `effectiveFrom`, default today). A direct edit writes an ALREADY-APPROVED
   * change_requests row plus a `change_request.approve`-shaped audit event, so
   * the effective-dated W-2 history (change-requests/address-history.ts) sees
   * one uniform history source regardless of which flow made the change.
   */
  app.patch("/api/admin/employees/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        taxId: z
          .string()
          .regex(/^\d{9}$/, "tax id must be 9 digits")
          .optional(),
        mailingAddress: addressSchema.optional(),
        effectiveFrom: isoDate.optional(),
      })
      .refine((d) => d.taxId !== undefined || d.mailingAddress !== undefined, {
        message: "provide taxId and/or mailingAddress",
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });

    if (body.data.taxId !== undefined) {
      const encrypted = encryptField(body.data.taxId, config.encryptionKey);
      await db
        .update(employees)
        .set({ taxId: encrypted, updatedAt: new Date() })
        .where(eq(employees.id, employeeId));
      await audit(
        req.authUser!.id,
        "employee.set_tax_id",
        String(employeeId),
        { taxIdMasked: maskLast4(employee.taxId, config.encryptionKey) },
        { taxIdMasked: maskLast4(encrypted, config.encryptionKey) },
      );
    }

    if (body.data.mailingAddress !== undefined) {
      // PAY-21: the change_request payload, the target field, and the audit
      // after-value all carry the stored (encrypted) form — same doctrine as
      // the approve flow in change-requests/service.ts.
      const stored = addressForStorage(body.data.mailingAddress, config.encryptionKey);
      const effectiveFrom = body.data.effectiveFrom ?? new Date().toISOString().slice(0, 10);
      const now = new Date();
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(changeRequests)
          .values({
            employeeId,
            requestType: "mailing_address",
            payload: stored,
            effectiveFrom,
            status: "approved",
            submittedAt: now,
            decidedBy: req.authUser!.id,
            decidedAt: now,
            appliedAt: now,
          })
          .returning();
        const request = inserted[0]!;
        await tx
          .update(employees)
          .set({ mailingAddress: stored, updatedAt: now })
          .where(eq(employees.id, employeeId));
        await tx.insert(auditEvents).values({
          actorId: req.authUser!.id,
          action: "change_request.approve",
          entity: "change_request",
          entityId: request.publicId,
          before: { mailingAddress: employee.mailingAddress },
          after: { applied: stored, effectiveFrom },
        });
      });
    }

    return { employee: await employeeWithUser(employeeId) };
  });

  /**
   * Invite the employee's user and link the records, or resend the invite
   * when the linked user never completed onboarding.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route handler with linear validation guard chain
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
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

      const result = await inviteUser(
        deps,
        { name: body.data.name, email: body.data.email, role: "employee" },
        req.authUser!.id,
        auditCtx,
      );
      await db
        .update(employees)
        .set({ userId: result.userId, updatedAt: new Date() })
        .where(eq(employees.id, employeeId));
      await audit(
        req.authUser!.id,
        "employee.link_user",
        String(employeeId),
        { userId: null },
        { userId: result.userId },
      );
      return reply.code(201).send({ ...result, resent: false });
    } catch (err) {
      if (err instanceof UserServiceError) {
        const status =
          err.code === "email_exists" ? 409 : err.code === "not_pending_enrollment" ? 409 : 404;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /** Disable (terminate + ban linked user) or re-enable. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route handler with linear validation guard chain
  app.post("/api/admin/employees/:employeeId/status", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        status: z.enum(["active", "terminated"]),
        terminationDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    if (employee.status === body.data.status) {
      return reply
        .code(409)
        .send({ error: "no_op", message: `employee is already '${employee.status}'` });
    }

    const terminating = body.data.status === "terminated";
    const updated = await db
      .update(employees)
      .set({
        status: body.data.status,
        terminationDate: terminating
          ? (body.data.terminationDate ?? new Date().toISOString().slice(0, 10))
          : null,
        updatedAt: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

    // Auth stays in sync: terminated employees lose access immediately.
    if (employee.userId) {
      const ctx = await auth.$context;
      if (terminating) {
        await ctx.internalAdapter.updateUser(employee.userId, {
          banned: true,
          banReason: "employee_terminated",
        });
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
