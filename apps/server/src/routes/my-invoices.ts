/**
 * Contractor-self invoice routes (PAY-7): the contractor analogue of
 * /api/payslips. A logged-in contractor sees their own invoices in status
 * 'approved' or 'paid' (owner decision D1, 2026-08-21 — submitted/rejected/
 * void are never exposed), with the 1:1 payment row joined when paid.
 * PDFs render on demand from the stored rows and are never stored.
 *
 * Scoping mirrors payslips.ts: resolve the caller's employees row and 404 on
 * foreign IDs (no enumeration). W-2 employees get an empty list — they have
 * payslips instead. Admins use the admin contractor routes; there is no
 * admin bypass here (support flows go through /admin/contractors).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { company, contractorInvoices, contractorPayments, employees } from "@payroll/db";
import { renderInvoicePdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { Guards } from "../plugins/guards.js";

interface MyInvoiceDeps {
  db: Db;
  guards: Guards;
}

/** Invoices a contractor may see (owner decision D1: approved + paid only). */
const VISIBLE_STATUSES = ["approved", "paid"] as const;

async function resolveEmployee(db: Db, userId: string) {
  const rows = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return rows[0] ?? null;
}

async function ownInvoice(
  db: Db,
  req: FastifyRequest,
  invoiceId: number,
): Promise<typeof contractorInvoices.$inferSelect | null> {
  const employee = await resolveEmployee(db, req.authUser!.id);
  if (!employee || employee.employmentType !== "1099") return null;
  const rows = await db
    .select()
    .from(contractorInvoices)
    .where(
      and(
        eq(contractorInvoices.id, invoiceId),
        eq(contractorInvoices.employeeId, employee.id),
        inArray(contractorInvoices.status, [...VISIBLE_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function registerMyInvoiceRoutes(app: FastifyInstance, deps: MyInvoiceDeps): void {
  const { db, guards } = deps;

  app.get("/api/my/invoices", { preHandler: guards.requireAuth }, async (req) => {
    const employee = await resolveEmployee(db, req.authUser!.id);
    if (!employee || employee.employmentType !== "1099") return { invoices: [] };

    const rows = await db
      .select({ invoice: contractorInvoices, payment: contractorPayments })
      .from(contractorInvoices)
      .leftJoin(contractorPayments, eq(contractorPayments.invoiceId, contractorInvoices.id))
      .where(
        and(
          eq(contractorInvoices.employeeId, employee.id),
          inArray(contractorInvoices.status, [...VISIBLE_STATUSES]),
        ),
      )
      .orderBy(desc(contractorInvoices.invoiceDate), desc(contractorInvoices.id));

    return {
      invoices: rows.map(({ invoice, payment }) => ({
        id: invoice.id,
        invoiceDate: invoice.invoiceDate,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        recurringPeriod: invoice.recurringPeriod,
        payment: payment
          ? {
              payDate: payment.payDate,
              amount: Number(payment.amount),
              method: payment.method,
              reference: payment.reference,
              backupWithheld: Number(payment.backupWithheld),
            }
          : null,
      })),
    };
  });

  app.get("/api/my/invoices/:id/pdf", { preHandler: guards.requireAuth }, async (req, reply) => {
    const invoiceId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1) {
      return reply.code(404).send({ error: "not_found" });
    }
    const invoice = await ownInvoice(db, req, invoiceId);
    if (!invoice) return reply.code(404).send({ error: "not_found" });

    const employee = await resolveEmployee(db, req.authUser!.id);
    const paymentRows = await db
      .select()
      .from(contractorPayments)
      .where(eq(contractorPayments.invoiceId, invoice.id))
      .limit(1);
    const payment = paymentRows[0] ?? null;
    const companyRows = await db.select({ legalName: company.legalName }).from(company).limit(1);

    const pdf = await renderInvoicePdf({
      company: { legalName: companyRows[0]?.legalName ?? "Payroll" },
      contractor: { legalName: employee!.legalName, preferredName: employee!.preferredName },
      invoiceDate: invoice.invoiceDate,
      description: invoice.description,
      amount: invoice.amount,
      currency: invoice.currency,
      status: invoice.status as "approved" | "paid",
      payment: payment
        ? {
            payDate: payment.payDate,
            amount: payment.amount,
            method: payment.method,
            reference: payment.reference,
            backupWithheld: payment.backupWithheld,
          }
        : null,
    });

    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="invoice-${invoice.invoiceDate}.pdf"`)
      .send(pdf);
  });
}
