/**
 * Admin contractor routes (spec 10): contractor CRUD (employees row +
 * contractor_details), the invoice queue (create/approve/reject/pay/void),
 * the year-end summary + on-demand 1099-NEC PDF, and the dated reporting
 * threshold config. All admin-role gated; every mutation audited.
 *
 * TIN is write-only: accepted on create/update, encrypted at rest, and NEVER
 * returned — the detail endpoint exposes only a ••••1234 mask (same doctrine
 * as employees.tax_id).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  contractorDetails,
  contractorInvoices,
  contractorPayments,
  contractorReportingConfig,
  employees,
} from "@payroll/db";
import { renderNec1099Pdf, type Nec1099Address } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { decryptField, maskLast4 } from "../crypto/field-encryption.js";
import {
  ContractorServiceError,
  createContractor,
  createInvoice,
  getContractor,
  recordPayment,
  requireNec1099Row,
  reviewInvoice,
  updateContractor,
  voidInvoice,
  yearEndSummary,
} from "../contractors/service.js";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from "../contractors/recurring.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const usDaysLogSchema = z.array(
  z.object({
    year: z.number().int().min(2000).max(2100),
    days: z.number().int().min(1).max(366),
    note: z.string().max(500).optional(),
  }),
);

const detailsFields = {
  taxStatus: z.enum(["us_person", "nonresident"]),
  entityType: z.enum(["individual", "entity"]),
  residenceCountry: z.string().trim().min(2).max(2),
  tin: z.string().trim().min(4).max(32),
  taxForm: z.enum(["w9", "w8ben", "w8ben_e", "w8eci"]),
  formCollectedAt: DATE,
  backupWithholding: z.boolean(),
  servicesLocation: z.enum(["foreign", "us", "mixed"]),
  usDaysLog: usDaysLogSchema,
};

function serviceError(
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  if (err instanceof ContractorServiceError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "invalid_input" ||
            err.code === "not_contractor" ||
            err.code === "no_company" ||
            err.code === "no_threshold_config"
          ? 400
          : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerAdminContractorRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
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
      .values({ actorId, action, entity: "contractor_reporting_config", entityId, before, after });
  }

  // ------------------------------------------------------------- contractors

  app.get("/api/admin/contractors", { preHandler: admin }, async () => {
    const rows = await db
      .select({
        employeeId: employees.id,
        legalName: employees.legalName,
        preferredName: employees.preferredName,
        hireDate: employees.hireDate,
        status: employees.status,
        taxStatus: contractorDetails.taxStatus,
        entityType: contractorDetails.entityType,
        residenceCountry: contractorDetails.residenceCountry,
        taxForm: contractorDetails.taxForm,
        formCollectedAt: contractorDetails.formCollectedAt,
        formExpiresAt: contractorDetails.formExpiresAt,
        backupWithholding: contractorDetails.backupWithholding,
        servicesLocation: contractorDetails.servicesLocation,
      })
      .from(employees)
      .innerJoin(contractorDetails, eq(contractorDetails.employeeId, employees.id))
      .where(eq(employees.employmentType, "1099"))
      .orderBy(asc(employees.legalName));
    return { contractors: rows };
  });

  app.post("/api/admin/contractors", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        legalName: z.string().trim().min(1).max(200),
        preferredName: z.string().trim().max(200).optional(),
        hireDate: DATE,
        taxStatus: detailsFields.taxStatus,
        entityType: detailsFields.entityType,
        residenceCountry: detailsFields.residenceCountry.optional(),
        tin: detailsFields.tin.optional(),
        taxForm: detailsFields.taxForm,
        formCollectedAt: detailsFields.formCollectedAt.optional(),
        backupWithholding: z.boolean().default(false),
        servicesLocation: detailsFields.servicesLocation.default("foreign"),
        usDaysLog: usDaysLogSchema.default([]),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const result = await createContractor({ db, config }, body.data, req.authUser!.id);
      return reply.code(201).send(result);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.get("/api/admin/contractors/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    try {
      const { employee, details } = await getContractor(db, employeeId);
      const invoiceRows = await db
        .select()
        .from(contractorInvoices)
        .where(eq(contractorInvoices.employeeId, employeeId))
        .orderBy(asc(contractorInvoices.invoiceDate), asc(contractorInvoices.id));
      const paymentRows = await db
        .select()
        .from(contractorPayments)
        .innerJoin(contractorInvoices, eq(contractorPayments.invoiceId, contractorInvoices.id))
        .where(eq(contractorInvoices.employeeId, employeeId));
      const paymentByInvoice = new Map(
        paymentRows.map((r) => [r.contractor_payments.invoiceId, r.contractor_payments]),
      );
      // TIN never leaves the server — only the ••••1234 mask for support flows.
      const { tin, ...safeDetails } = details;
      const { taxId: _taxId, bankDetails: _bankDetails, ...safeEmployee } = employee;
      return {
        contractor: {
          ...safeEmployee,
          details: { ...safeDetails, tinMasked: maskLast4(tin, config.encryptionKey) },
        },
        invoices: invoiceRows.map((inv) => ({
          ...inv,
          payment: paymentByInvoice.get(inv.id) ?? null,
        })),
      };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.patch("/api/admin/contractors/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        legalName: z.string().trim().min(1).max(200).optional(),
        preferredName: z.string().trim().max(200).nullable().optional(),
        taxStatus: detailsFields.taxStatus.optional(),
        entityType: detailsFields.entityType.optional(),
        residenceCountry: detailsFields.residenceCountry.nullable().optional(),
        tin: detailsFields.tin.nullable().optional(),
        taxForm: detailsFields.taxForm.optional(),
        formCollectedAt: detailsFields.formCollectedAt.nullable().optional(),
        backupWithholding: z.boolean().optional(),
        servicesLocation: detailsFields.servicesLocation.optional(),
        usDaysLog: usDaysLogSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      await updateContractor({ db, config }, employeeId, body.data, req.authUser!.id);
      return { ok: true };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // ---------------------------------------------------------------- invoices

  app.post(
    "/api/admin/contractors/:employeeId/invoices",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      const body = z
        .object({
          invoiceRef: z.string().trim().max(100).optional(),
          description: z.string().trim().min(1).max(500),
          amount: z.number().positive(),
          currency: z.string().trim().min(3).max(3).default("USD"),
          invoiceDate: DATE,
        })
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      try {
        // V1 (D16): admin-entered — submitted_by is always NULL.
        const invoice = await createInvoice(
          { db, config },
          employeeId,
          { ...body.data, submittedBy: null },
          req.authUser!.id,
        );
        return reply.code(201).send({ invoice });
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.post("/api/admin/invoices/:invoiceId/approve", { preHandler: admin }, async (req, reply) => {
    const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
    const body = z
      .object({ note: z.string().trim().max(500).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const invoice = await reviewInvoice({ db, config }, invoiceId, {
        action: "approve",
        note: body.data.note,
        actorId: req.authUser!.id,
      });
      return { invoice };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/invoices/:invoiceId/reject", { preHandler: admin }, async (req, reply) => {
    const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
    const body = z.object({ note: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const invoice = await reviewInvoice({ db, config }, invoiceId, {
        action: "reject",
        note: body.data.note,
        actorId: req.authUser!.id,
      });
      return { invoice };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/invoices/:invoiceId/pay", { preHandler: admin }, async (req, reply) => {
    const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
    const body = z
      .object({
        payDate: DATE,
        amount: z.number().positive(),
        exchangeRate: z.number().positive().nullable().optional(),
        method: z.enum(["ach", "check", "wire", "card", "third_party_network"]),
        reference: z.string().trim().max(100).optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const result = await recordPayment({ db, config }, invoiceId, body.data, req.authUser!.id);
      return reply.code(201).send(result);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/invoices/:invoiceId/void", { preHandler: admin }, async (req, reply) => {
    const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
    const body = z.object({ note: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const invoice = await voidInvoice({ db, config }, invoiceId, {
        note: body.data.note,
        actorId: req.authUser!.id,
      });
      return { invoice };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // ------------------------------------------------- recurring templates (spec 12)

  const recurringFields = {
    description: z.string().trim().min(1).max(500),
    amount: z.number().positive(),
    currency: z.string().trim().min(3).max(3),
    invoiceDay: z.enum(["last_day", "fixed"]),
    invoiceDayOfMonth: z.number().int().min(1).max(28).nullable(),
    payDayOfMonth: z.number().int().min(1).max(28),
    startsOn: DATE,
    endsOn: DATE.nullable(),
  };

  app.get(
    "/api/admin/contractors/:employeeId/recurring",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      try {
        return { templates: await listTemplates({ db, config }, employeeId) };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.post(
    "/api/admin/contractors/:employeeId/recurring",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      const body = z
        .object({
          description: recurringFields.description,
          amount: recurringFields.amount,
          currency: recurringFields.currency.default("USD"),
          invoiceDay: recurringFields.invoiceDay.default("last_day"),
          invoiceDayOfMonth: recurringFields.invoiceDayOfMonth.optional(),
          payDayOfMonth: recurringFields.payDayOfMonth,
          startsOn: recurringFields.startsOn,
          endsOn: recurringFields.endsOn.optional(),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      try {
        const template = await createTemplate(
          { db, config },
          employeeId,
          body.data,
          req.authUser!.id,
        );
        return reply.code(201).send({ template });
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  // Edits affect future generations only (D25); active toggles pause/resume.
  app.patch("/api/admin/recurring/:templateId", { preHandler: admin }, async (req, reply) => {
    const templateId = Number((req.params as { templateId: string }).templateId);
    const body = z
      .object({
        description: recurringFields.description.optional(),
        amount: recurringFields.amount.optional(),
        currency: recurringFields.currency.optional(),
        invoiceDay: recurringFields.invoiceDay.optional(),
        invoiceDayOfMonth: recurringFields.invoiceDayOfMonth.optional(),
        payDayOfMonth: recurringFields.payDayOfMonth.optional(),
        startsOn: recurringFields.startsOn.optional(),
        endsOn: recurringFields.endsOn.optional(),
        active: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const template = await updateTemplate(
        { db, config },
        templateId,
        body.data,
        req.authUser!.id,
      );
      return { template };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // Delete only before the first generation (D25) — afterwards pause/end only.
  app.delete("/api/admin/recurring/:templateId", { preHandler: admin }, async (req, reply) => {
    const templateId = Number((req.params as { templateId: string }).templateId);
    try {
      await deleteTemplate({ db, config }, templateId, req.authUser!.id);
      return { ok: true };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // ---------------------------------------------------------------- year-end

  app.get("/api/admin/contractors/year-end", { preHandler: admin }, async (req, reply) => {
    const q = z.object({ year: z.coerce.number().int().min(2020).max(2100) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
    try {
      return await yearEndSummary(db, q.data.year);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  /**
   * On-demand 1099-NEC substitute-statement PDF (spec 10 §3): deterministic
   * from stored payments, generated — never stored (same doctrine as payslips).
   */
  app.get(
    "/api/admin/contractors/:employeeId/1099-nec",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      const q = z
        .object({ year: z.coerce.number().int().min(2020).max(2100) })
        .safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
      try {
        const row = await requireNec1099Row(db, employeeId, q.data.year);
        const [companyRow] = await db.select().from(company).limit(1);
        const pdf = await renderNec1099Pdf({
          taxYear: q.data.year,
          payer: {
            legalName: companyRow?.legalName ?? "Unknown",
            ein: companyRow?.ein ? decryptField(companyRow.ein, config.encryptionKey) : null,
            address: (companyRow?.address as Nec1099Address | null) ?? null,
          },
          recipient: { legalName: row.legalName },
          box1: row.reportableTotal,
          box4: row.backupWithheldTotal,
          threshold: row.threshold,
        });
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="1099-nec-${q.data.year}-contractor-${employeeId}.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  // ------------------------------------------------- reporting config (§3)

  app.get("/api/admin/contractor-reporting-config", { preHandler: admin }, async () => {
    const rows = await db
      .select()
      .from(contractorReportingConfig)
      .orderBy(asc(contractorReportingConfig.taxYear));
    return { config: rows };
  });

  app.put("/api/admin/contractor-reporting-config", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        taxYear: z.number().int().min(2020).max(2100),
        necThreshold: z.number().min(0),
        note: z.string().trim().max(500).default(""),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const before = await db
      .select()
      .from(contractorReportingConfig)
      .where(eq(contractorReportingConfig.taxYear, body.data.taxYear))
      .limit(1);
    const values = {
      taxYear: body.data.taxYear,
      necThreshold: String(body.data.necThreshold),
      note: body.data.note,
      updatedAt: new Date(),
    };
    const upserted = await db
      .insert(contractorReportingConfig)
      .values(values)
      .onConflictDoUpdate({ target: [contractorReportingConfig.taxYear], set: values })
      .returning();
    await audit(
      req.authUser!.id,
      "contractor_reporting_config.upsert",
      String(body.data.taxYear),
      before[0] ?? null,
      upserted[0],
    );
    return { config: upserted[0] };
  });
}
