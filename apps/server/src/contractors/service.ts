/**
 * Contractor service (spec 10) — the classification/forms layer and the
 * invoice → approve → pay money flow for employment_type='1099' workers.
 * Deliberately separate from the payroll engine: no snapshot, no payslip,
 * no gross→net computation.
 *
 * Guardrails (spec 10 §4):
 * - Payment gate: recording a payment requires form_collected_at set and the
 *   form unexpired at pay_date — hard server error naming the form.
 * - Backup withholding: 24% of the payment when backup_withholding is set.
 * - W-8 lifecycle mirrors the W-4 renewal-deadline pattern: expiry date on
 *   the row, outbox notification to admins 30 days out and at expiry.
 * - us_days_log non-empty or services_location us/mixed → 1042-S review flag
 *   (detection only; no 1042-S generation, spec 10 §7).
 *
 * Every mutation writes audit_events in the same transaction.
 */

import { and, asc, desc, eq, gte, isNotNull, like, lte, ne, or, isNull } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  company,
  contractorDetails,
  contractorInvoices,
  contractorPayments,
  contractorReportingConfig,
  emailOutbox,
  employees,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import {
  EVENT_TYPE,
  contractorFormExpired as tplFormExpired,
  contractorFormExpiring as tplFormExpiring,
  contractorInvoicePaid as tplInvoicePaid,
  contractorInvoiceReviewed as tplInvoiceReviewed,
  contractorInvoiceSubmitted as tplInvoiceSubmitted,
  taxFormLabel,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { encryptField } from "../crypto/field-encryption.js";

export type TaxStatus = "us_person" | "nonresident";
export type EntityType = "individual" | "entity";
export type TaxForm = "w9" | "w8ben" | "w8ben_e" | "w8eci";
export type ServicesLocation = "foreign" | "us" | "mixed";
export type PaymentMethod = "ach" | "check" | "wire" | "card" | "third_party_network";
export type InvoiceStatus = "submitted" | "approved" | "rejected" | "paid" | "void";

export interface UsDayEntry {
  year: number;
  days: number;
  note?: string | undefined;
}

export class ContractorServiceError extends Error {
  constructor(
    public code:
      | "not_found"
      | "not_contractor"
      | "no_company"
      | "invalid_input"
      | "invalid_transition"
      | "note_required"
      | "form_missing"
      | "form_expired"
      | "no_threshold_config"
      | "no_form_required"
      | "review_1042_required",
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  db: Db;
  config: AppConfig;
}

export type ContractorDetailsRow = typeof contractorDetails.$inferSelect;
export type InvoiceRow = typeof contractorInvoices.$inferSelect;
export type PaymentRow = typeof contractorPayments.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Methods excluded from 1099-NEC (the processor files 1099-K) — spec 10 §3. */
export const NON_REPORTABLE_METHODS: readonly PaymentMethod[] = ["card", "third_party_network"];

/** Backup withholding rate (IRC §3406) — the one withholding a contractor payment can have. */
export const BACKUP_WITHHOLDING_RATE = 0.24;

/**
 * W-8BEN/W-8BEN-E validity (spec 10 §1: collected_at + 3 calendar years):
 * a form collected any time in year Y stays valid through December 31 of
 * Y+3. w9/w8eci never auto-expire → null.
 */
export function formExpiryDate(taxForm: TaxForm, formCollectedAt: string | null): string | null {
  if (!formCollectedAt) return null;
  if (taxForm !== "w8ben" && taxForm !== "w8ben_e") return null;
  const year = Number(formCollectedAt.slice(0, 4));
  return `${year + 3}-12-31`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function templateCtx(db: Db, config: AppConfig): Promise<TemplateContext> {
  const rows = await db.select({ legalName: company.legalName }).from(company).limit(1);
  return { companyName: rows[0]?.legalName ?? "Payroll", appUrl: config.baseUrl };
}

async function adminUserIds(db: Deps["db"]): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Contractor CRUD
// ---------------------------------------------------------------------------

export interface ContractorCreateInput {
  legalName: string;
  preferredName?: string | undefined;
  hireDate: string;
  taxStatus: TaxStatus;
  entityType: EntityType;
  /** Required when taxStatus='nonresident'. */
  residenceCountry?: string | undefined;
  /** Encrypted at rest like employees.tax_id; never returned by any endpoint. */
  tin?: string | undefined;
  taxForm: TaxForm;
  formCollectedAt?: string | undefined;
  backupWithholding?: boolean | undefined;
  servicesLocation?: ServicesLocation | undefined;
  usDaysLog?: UsDayEntry[] | undefined;
}

export interface ContractorUpdateInput {
  legalName?: string | undefined;
  preferredName?: string | null | undefined;
  taxStatus?: TaxStatus | undefined;
  entityType?: EntityType | undefined;
  residenceCountry?: string | null | undefined;
  tin?: string | null | undefined;
  taxForm?: TaxForm | undefined;
  formCollectedAt?: string | null | undefined;
  backupWithholding?: boolean | undefined;
  servicesLocation?: ServicesLocation | undefined;
  usDaysLog?: UsDayEntry[] | undefined;
}

async function loadContractor(
  db: Deps["db"],
  employeeId: number,
): Promise<{ employee: typeof employees.$inferSelect; details: ContractorDetailsRow }> {
  const rows = await db
    .select({ employee: employees, details: contractorDetails })
    .from(employees)
    .innerJoin(contractorDetails, eq(contractorDetails.employeeId, employees.id))
    .where(eq(employees.id, employeeId))
    .limit(1);
  const row = rows[0];
  if (!row || row.employee.employmentType !== "1099") {
    throw new ContractorServiceError("not_found", `contractor ${employeeId} not found`);
  }
  return row;
}

/** Create the employees row (employment_type='1099') + contractor_details atomically. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: create transaction; validation guard chain is the spec's field rules
export async function createContractor(
  deps: Deps,
  input: ContractorCreateInput,
  actorId: string,
): Promise<{ employeeId: number }> {
  const { db, config } = deps;
  if (input.taxStatus === "nonresident" && !input.residenceCountry?.trim()) {
    throw new ContractorServiceError(
      "invalid_input",
      "residence_country is required when tax_status is 'nonresident'",
    );
  }
  if (!DATE_RE.test(input.hireDate)) {
    throw new ContractorServiceError("invalid_input", "hireDate must be YYYY-MM-DD");
  }
  if (input.formCollectedAt && !DATE_RE.test(input.formCollectedAt)) {
    throw new ContractorServiceError("invalid_input", "formCollectedAt must be YYYY-MM-DD");
  }

  return db.transaction(async (tx) => {
    const companyRows = await tx.select({ id: company.id }).from(company).limit(1);
    const companyRow = companyRows[0];
    if (!companyRow) {
      throw new ContractorServiceError("no_company", "company row missing — run seeds");
    }
    const inserted = await tx
      .insert(employees)
      .values({
        companyId: companyRow.id,
        employmentType: "1099",
        legalName: input.legalName,
        preferredName: input.preferredName ?? null,
        hireDate: input.hireDate,
      })
      .returning();
    const employee = inserted[0]!;

    await tx.insert(contractorDetails).values({
      employeeId: employee.id,
      taxStatus: input.taxStatus,
      entityType: input.entityType,
      residenceCountry: input.residenceCountry ?? null,
      tin: input.tin ? encryptField(input.tin, config.encryptionKey) : null,
      taxForm: input.taxForm,
      formCollectedAt: input.formCollectedAt ?? null,
      formExpiresAt: formExpiryDate(input.taxForm, input.formCollectedAt ?? null),
      backupWithholding: input.backupWithholding ?? false,
      servicesLocation: input.servicesLocation ?? "foreign",
      usDaysLog: input.usDaysLog ?? [],
    });

    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor.create",
      entity: "employee",
      entityId: String(employee.id),
      before: null,
      after: {
        legalName: input.legalName,
        taxStatus: input.taxStatus,
        entityType: input.entityType,
        taxForm: input.taxForm,
        formCollectedAt: input.formCollectedAt ?? null,
      },
    });
    return { employeeId: employee.id };
  });
}

/** Merge an update over the existing row; recomputes form_expires_at app-side. */
function resolveDetailsPatch(
  existing: ContractorDetailsRow,
  input: ContractorUpdateInput,
  encryptionKey: string,
): { patch: Partial<typeof contractorDetails.$inferInsert>; after: Record<string, unknown> } {
  const taxStatus = input.taxStatus ?? existing.taxStatus;
  const residenceCountry =
    input.residenceCountry === undefined ? existing.residenceCountry : input.residenceCountry;
  if (taxStatus === "nonresident" && !residenceCountry?.trim()) {
    throw new ContractorServiceError(
      "invalid_input",
      "residence_country is required when tax_status is 'nonresident'",
    );
  }
  const taxForm = (input.taxForm ?? existing.taxForm) as TaxForm;
  const formCollectedAt =
    input.formCollectedAt === undefined ? existing.formCollectedAt : input.formCollectedAt;
  const formExpiresAt = formExpiryDate(taxForm, formCollectedAt);
  const backupWithholding = input.backupWithholding ?? existing.backupWithholding;
  return {
    patch: {
      taxStatus,
      entityType: input.entityType ?? existing.entityType,
      residenceCountry,
      tin:
        input.tin === undefined
          ? existing.tin
          : input.tin === null
            ? null
            : encryptField(input.tin, encryptionKey),
      taxForm,
      formCollectedAt,
      formExpiresAt,
      backupWithholding,
      servicesLocation: input.servicesLocation ?? existing.servicesLocation,
      usDaysLog: input.usDaysLog ?? existing.usDaysLog,
      updatedAt: new Date(),
    },
    after: { taxStatus, taxForm, formCollectedAt, formExpiresAt, backupWithholding },
  };
}

/**
 * Edit contractor_details (+ employee display name). form_expires_at is
 * recomputed app-side whenever tax_form / form_collected_at changes — admins
 * never set it directly.
 */
export async function updateContractor(
  deps: Deps,
  employeeId: number,
  input: ContractorUpdateInput,
  actorId: string,
): Promise<void> {
  const { db, config } = deps;
  const { details: before } = await loadContractor(db, employeeId);
  const { patch, after } = resolveDetailsPatch(before, input, config.encryptionKey);

  await db.transaction(async (tx) => {
    if (input.legalName !== undefined || input.preferredName !== undefined) {
      await tx
        .update(employees)
        .set({
          ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
          ...(input.preferredName !== undefined ? { preferredName: input.preferredName } : {}),
          updatedAt: new Date(),
        })
        .where(eq(employees.id, employeeId));
    }

    await tx
      .update(contractorDetails)
      .set(patch)
      .where(eq(contractorDetails.employeeId, employeeId));

    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor.update",
      entity: "contractor_details",
      entityId: String(employeeId),
      before: {
        taxStatus: before.taxStatus,
        taxForm: before.taxForm,
        formCollectedAt: before.formCollectedAt,
        formExpiresAt: before.formExpiresAt,
        backupWithholding: before.backupWithholding,
      },
      after,
    });
  });
}

export async function getContractor(db: Deps["db"], employeeId: number) {
  return loadContractor(db, employeeId);
}

// ---------------------------------------------------------------------------
// Invoices & payments (spec 10 §2)
// ---------------------------------------------------------------------------

export interface InvoiceCreateInput {
  invoiceRef?: string | undefined;
  description: string;
  amount: number;
  currency?: string | undefined;
  invoiceDate: string;
  /** user.id when a contractor self-submits (D16 deferred); NULL = admin-entered. */
  submittedBy?: string | null | undefined;
}

export async function createInvoice(
  deps: Deps,
  employeeId: number,
  input: InvoiceCreateInput,
  actorId: string,
): Promise<InvoiceRow> {
  const { db, config } = deps;
  const { employee } = await loadContractor(db, employeeId);
  if (input.amount <= 0) {
    throw new ContractorServiceError("invalid_input", "amount must be positive");
  }
  if (!DATE_RE.test(input.invoiceDate)) {
    throw new ContractorServiceError("invalid_input", "invoiceDate must be YYYY-MM-DD");
  }

  // Notification data gathered BEFORE the transaction (PGlite runs the app
  // single-connection; non-tx reads mid-transaction are not allowed).
  const submitted = Boolean(input.submittedBy);
  const ctx = submitted ? await templateCtx(db, config) : null;
  const admins = submitted ? await adminUserIds(db) : [];

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contractorInvoices)
      .values({
        employeeId,
        invoiceRef: input.invoiceRef ?? null,
        description: input.description,
        amount: String(input.amount),
        currency: input.currency ?? "USD",
        invoiceDate: input.invoiceDate,
        status: "submitted",
        submittedBy: input.submittedBy ?? null,
      })
      .returning();
    const invoice = inserted[0]!;

    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor_invoice.create",
      entity: "contractor_invoice",
      entityId: String(invoice.id),
      before: null,
      after: {
        employeeId,
        description: input.description,
        amount: String(input.amount),
        submittedBy: input.submittedBy ?? null,
      },
    });

    // Spec 10 §2 "invoice submitted → admin notified" — meaningful only when a
    // contractor self-submits (D16 portal); V1 invoices are admin-entered
    // (submitted_by NULL), where notifying the enterer would be noise.
    if (ctx) {
      const rendered = tplInvoiceSubmitted(ctx, {
        contractorName: employee.legalName,
        description: input.description,
      });
      for (const adminId of admins) {
        await tx.insert(emailOutbox).values({
          userId: adminId,
          eventType: EVENT_TYPE.contractorInvoiceSubmitted,
          subject: rendered.subject,
          bodyHtml: rendered.html,
        });
      }
    }
    return invoice;
  });
}

async function loadInvoice(db: Deps["db"], invoiceId: number): Promise<InvoiceRow> {
  const rows = await db
    .select()
    .from(contractorInvoices)
    .where(eq(contractorInvoices.id, invoiceId))
    .limit(1);
  const invoice = rows[0];
  if (!invoice) {
    throw new ContractorServiceError("not_found", `invoice ${invoiceId} not found`);
  }
  return invoice;
}

/** Linked portal account for contractor-facing emails (D16 deferred — usually none). */
async function contractorUserId(db: Deps["db"], employeeId: number): Promise<string | null> {
  const rows = await db
    .select({ userId: employees.userId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

/** Approve or reject a submitted invoice (reject requires a note — spec 10 §2). */
export async function reviewInvoice(
  deps: Deps,
  invoiceId: number,
  input: { action: "approve" | "reject"; note?: string | undefined; actorId: string },
): Promise<InvoiceRow> {
  const { db, config } = deps;
  if (input.action === "reject" && !input.note?.trim()) {
    throw new ContractorServiceError("note_required", "rejecting an invoice requires a note");
  }
  const invoice = await loadInvoice(db, invoiceId);
  if (invoice.status !== "submitted") {
    throw new ContractorServiceError(
      "invalid_transition",
      `cannot ${input.action} an invoice in status '${invoice.status}'`,
    );
  }
  const next = input.action === "approve" ? "approved" : "rejected";
  const ctx = await templateCtx(db, config);
  const recipientId = await contractorUserId(db, invoice.employeeId);

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(contractorInvoices)
      .set({
        status: next,
        reviewedBy: input.actorId,
        reviewedAt: new Date(),
        reviewNote: input.note?.trim() || null,
      })
      .where(eq(contractorInvoices.id, invoiceId))
      .returning();

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      action: `contractor_invoice.${input.action}`,
      entity: "contractor_invoice",
      entityId: String(invoiceId),
      before: { status: invoice.status },
      after: { status: next, ...(input.note ? { note: input.note } : {}) },
    });

    if (recipientId) {
      const rendered = tplInvoiceReviewed(ctx, {
        description: invoice.description,
        approved: input.action === "approve",
        note: input.note?.trim() || null,
      });
      await tx.insert(emailOutbox).values({
        userId: recipientId,
        eventType: EVENT_TYPE.contractorInvoiceReviewed,
        subject: rendered.subject,
        bodyHtml: rendered.html,
      });
    }
    return updated[0]!;
  });
}

export interface PaymentInput {
  payDate: string;
  /** USD actually paid. */
  amount: number;
  /** NULL when the invoice was already USD. */
  exchangeRate?: number | null | undefined;
  method: PaymentMethod;
  reference?: string | undefined;
}

/**
 * Record the payment settling an approved invoice (1:1 in v1). Payment gate
 * (spec 10 §4, D17): the contractor's form must be collected and unexpired at
 * pay_date — hard error naming the missing/expired form. Backup withholding
 * is computed server-side: 24% of the amount when backup_withholding is set.
 */
export async function recordPayment(
  deps: Deps,
  invoiceId: number,
  input: PaymentInput,
  actorId: string,
): Promise<{ invoice: InvoiceRow; payment: PaymentRow }> {
  const { db, config } = deps;
  if (!DATE_RE.test(input.payDate)) {
    throw new ContractorServiceError("invalid_input", "payDate must be YYYY-MM-DD");
  }
  if (input.amount <= 0) {
    throw new ContractorServiceError("invalid_input", "amount must be positive");
  }
  const invoice = await loadInvoice(db, invoiceId);
  if (invoice.status !== "approved") {
    throw new ContractorServiceError(
      "invalid_transition",
      `cannot record a payment for an invoice in status '${invoice.status}' (only approved → paid)`,
    );
  }
  const { employee, details } = await loadContractor(db, invoice.employeeId);

  // --- Payment gate (D17): W-9/W-8 on file before money moves. ---
  const form = taxFormLabel(details.taxForm);
  if (!details.formCollectedAt) {
    throw new ContractorServiceError(
      "form_missing",
      `cannot record payment — form ${form} has not been collected for ${employee.legalName}`,
    );
  }
  if (details.formExpiresAt && details.formExpiresAt <= input.payDate) {
    throw new ContractorServiceError(
      "form_expired",
      `cannot record payment — form ${form} for ${employee.legalName} expired on ${details.formExpiresAt}`,
    );
  }

  const backupWithheld = details.backupWithholding
    ? round2(input.amount * BACKUP_WITHHOLDING_RATE)
    : 0;
  const ctx = await templateCtx(db, config);
  const recipientId = await contractorUserId(db, invoice.employeeId);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contractorPayments)
      .values({
        invoiceId,
        payDate: input.payDate,
        amount: String(input.amount),
        exchangeRate: input.exchangeRate != null ? String(input.exchangeRate) : null,
        method: input.method,
        backupWithheld: String(backupWithheld),
        reference: input.reference ?? null,
      })
      .returning();
    const payment = inserted[0]!;

    const updated = await tx
      .update(contractorInvoices)
      .set({ status: "paid" })
      .where(eq(contractorInvoices.id, invoiceId))
      .returning();

    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor_invoice.pay",
      entity: "contractor_invoice",
      entityId: String(invoiceId),
      before: { status: invoice.status },
      after: {
        status: "paid",
        payDate: input.payDate,
        amount: String(input.amount),
        method: input.method,
        backupWithheld: String(backupWithheld),
      },
    });

    if (recipientId) {
      const rendered = tplInvoicePaid(ctx, {
        description: invoice.description,
        payDate: input.payDate,
      });
      await tx.insert(emailOutbox).values({
        userId: recipientId,
        eventType: EVENT_TYPE.contractorInvoicePaid,
        subject: rendered.subject,
        bodyHtml: rendered.html,
      });
    }
    return { invoice: updated[0]!, payment };
  });
}

/**
 * Void an invoice (note required — spec 10 §2: paid is terminal except void).
 * The payment row is KEPT for audit; year-end totals exclude payments whose
 * invoice is void.
 */
export async function voidInvoice(
  deps: Deps,
  invoiceId: number,
  input: { note: string; actorId: string },
): Promise<InvoiceRow> {
  const { db } = deps;
  if (!input.note?.trim()) {
    throw new ContractorServiceError("note_required", "voiding an invoice requires a note");
  }
  const invoice = await loadInvoice(db, invoiceId);
  if (invoice.status === "void") {
    throw new ContractorServiceError("invalid_transition", "invoice is already void");
  }
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(contractorInvoices)
      .set({
        status: "void",
        reviewedBy: input.actorId,
        reviewedAt: new Date(),
        reviewNote: `void: ${input.note.trim()}`,
      })
      .where(eq(contractorInvoices.id, invoiceId))
      .returning();

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      action: "contractor_invoice.void",
      entity: "contractor_invoice",
      entityId: String(invoiceId),
      before: { status: invoice.status },
      after: { status: "void", note: input.note },
    });
    return updated[0]!;
  });
}

// ---------------------------------------------------------------------------
// Year-end reporting (spec 10 §3)
// ---------------------------------------------------------------------------

/**
 * Resolve the dated 1099-NEC threshold for a tax year: exact row, else the
 * latest earlier row (one 2025 row covers every year ≤ 2025; 2026 covers
 * 2027+ until an admin enters the indexed figure). Never a hardcoded constant.
 */
export async function resolveNecThreshold(
  db: Deps["db"],
  taxYear: number,
): Promise<typeof contractorReportingConfig.$inferSelect> {
  const exact = await db
    .select()
    .from(contractorReportingConfig)
    .where(eq(contractorReportingConfig.taxYear, taxYear))
    .limit(1);
  if (exact[0]) return exact[0];
  const earlier = await db
    .select()
    .from(contractorReportingConfig)
    .where(lte(contractorReportingConfig.taxYear, taxYear))
    .orderBy(desc(contractorReportingConfig.taxYear))
    .limit(1);
  if (earlier[0]) return earlier[0];
  throw new ContractorServiceError(
    "no_threshold_config",
    `no contractor_reporting_config row for ${taxYear} or any earlier year — run seeds`,
  );
}

export interface YearEndPayment {
  payDate: string;
  amount: string;
  method: string;
  backupWithheld: string;
  reference: string | null;
}

export interface YearEndRow {
  employeeId: number;
  legalName: string;
  taxStatus: string;
  entityType: string;
  taxForm: string;
  formCollectedAt: string | null;
  formExpiresAt: string | null;
  /** Form expired as of `asOf` (default: today) — the payment gate's current state. */
  formExpired: boolean;
  servicesLocation: string;
  /** us_days_log non-empty or services us/mixed → 1042-S review, no 1099-NEC (spec 10 §4). */
  review1042: boolean;
  payments: YearEndPayment[];
  /** Sum of payments EXCLUDING card/third_party_network (1099-K carve-out). */
  reportableTotal: number;
  /** All payments in the year regardless of method. */
  grossTotal: number;
  backupWithheldTotal: number;
  threshold: number;
  /** us_person && reportable ≥ threshold && !review1042 → generate a 1099-NEC. */
  formRequired: boolean;
}

/**
 * Per-contractor year-end summary: reportable totals (1099-K carve-out
 * applied), the dated threshold, and the form-required / 1042-S review flags.
 * Below-threshold contractors stay visible — the threshold decision is never
 * silent (spec 10 §3). Payments on void invoices are excluded.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: aggregation over contractors; per-row branches are the spec's reporting rules
export async function yearEndSummary(
  db: Deps["db"],
  taxYear: number,
  opts: { asOf?: string } = {},
): Promise<{ taxYear: number; threshold: string; rows: YearEndRow[] }> {
  const asOf = opts.asOf ?? todayIso();
  const thresholdRow = await resolveNecThreshold(db, taxYear);
  const threshold = Number(thresholdRow.necThreshold);

  const contractors = await db
    .select({ employee: employees, details: contractorDetails })
    .from(employees)
    .innerJoin(contractorDetails, eq(contractorDetails.employeeId, employees.id))
    .where(eq(employees.employmentType, "1099"))
    .orderBy(asc(employees.legalName), asc(employees.id));

  const paymentRows = await db
    .select({
      employeeId: contractorInvoices.employeeId,
      payDate: contractorPayments.payDate,
      amount: contractorPayments.amount,
      method: contractorPayments.method,
      backupWithheld: contractorPayments.backupWithheld,
      reference: contractorPayments.reference,
    })
    .from(contractorPayments)
    .innerJoin(contractorInvoices, eq(contractorPayments.invoiceId, contractorInvoices.id))
    .where(
      and(
        ne(contractorInvoices.status, "void"),
        gte(contractorPayments.payDate, `${taxYear}-01-01`),
        lte(contractorPayments.payDate, `${taxYear}-12-31`),
      ),
    )
    .orderBy(asc(contractorPayments.payDate), asc(contractorPayments.id));

  const byEmployee = new Map<number, typeof paymentRows>();
  for (const p of paymentRows) {
    const list = byEmployee.get(p.employeeId) ?? [];
    list.push(p);
    byEmployee.set(p.employeeId, list);
  }

  const rows: YearEndRow[] = contractors.map(({ employee, details }) => {
    const payments = (byEmployee.get(employee.id) ?? []).map((p) => ({
      payDate: p.payDate,
      amount: p.amount,
      method: p.method,
      backupWithheld: p.backupWithheld,
      reference: p.reference,
    }));
    const reportableTotal = round2(
      payments
        .filter((p) => !NON_REPORTABLE_METHODS.includes(p.method as PaymentMethod))
        .reduce((sum, p) => sum + Number(p.amount), 0),
    );
    const grossTotal = round2(payments.reduce((sum, p) => sum + Number(p.amount), 0));
    const backupWithheldTotal = round2(
      payments.reduce((sum, p) => sum + Number(p.backupWithheld), 0),
    );
    const usDaysLog = (details.usDaysLog ?? []) as UsDayEntry[];
    const review1042 = usDaysLog.length > 0 || details.servicesLocation !== "foreign";
    const formRequired =
      details.taxStatus === "us_person" && reportableTotal >= threshold && !review1042;
    return {
      employeeId: employee.id,
      legalName: employee.legalName,
      taxStatus: details.taxStatus,
      entityType: details.entityType,
      taxForm: details.taxForm,
      formCollectedAt: details.formCollectedAt,
      formExpiresAt: details.formExpiresAt,
      formExpired: details.formExpiresAt !== null && details.formExpiresAt <= asOf,
      servicesLocation: details.servicesLocation,
      review1042,
      payments,
      reportableTotal,
      grossTotal,
      backupWithheldTotal,
      threshold,
      formRequired,
    };
  });

  return { taxYear, threshold: thresholdRow.necThreshold, rows };
}

/**
 * Gate for the on-demand 1099-NEC PDF: the contractor must be a US person at
 * or above the year's threshold with no 1042-S review flag. Returns the
 * year-end row on success; throws a named error otherwise (spec 10 §3/§4).
 */
export async function requireNec1099Row(
  db: Deps["db"],
  employeeId: number,
  taxYear: number,
): Promise<YearEndRow> {
  const { rows } = await yearEndSummary(db, taxYear);
  const row = rows.find((r) => r.employeeId === employeeId);
  if (!row) throw new ContractorServiceError("not_found", `contractor ${employeeId} not found`);
  if (row.taxStatus !== "us_person") {
    throw new ContractorServiceError(
      "no_form_required",
      `${row.legalName} is not a US person — no 1099-NEC (W-8 on file; see 1042-S rules for US-source income)`,
    );
  }
  if (row.review1042) {
    throw new ContractorServiceError(
      "review_1042_required",
      `${row.legalName} has US-source indicators (us_days_log / services_location '${row.servicesLocation}') — 1042-S review required instead of a 1099-NEC`,
    );
  }
  if (!row.formRequired) {
    throw new ContractorServiceError(
      "no_form_required",
      `reportable payments ${row.reportableTotal.toFixed(2)} are below the ${taxYear} threshold of ${row.threshold.toFixed(2)} — no form required`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// W-8 expiry notifications (spec 10 §4 — W-4 renewal-deadline pattern)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * Notify admins about W-8 forms expiring within 30 days and forms already
 * expired (the payment gate has re-armed). Idempotent: an outbox marker per
 * (employee, kind, expiry date) suppresses repeats, so the daily scheduler
 * tick never double-mails.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: expiry sweep loop; per-row kind/dedupe branches are the domain logic
export async function checkContractorFormExpiry(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ expiring: number; expired: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const rows = await db
    .select({ employee: employees, details: contractorDetails })
    .from(contractorDetails)
    .innerJoin(employees, eq(employees.id, contractorDetails.employeeId))
    .where(and(isNotNull(contractorDetails.formExpiresAt), eq(employees.status, "active")));

  const ctx = await templateCtx(db, config);
  const admins = await adminUserIds(db);
  const result = { expiring: 0, expired: 0 };

  for (const { employee, details } of rows) {
    const expiresAt = details.formExpiresAt!;
    const daysLeft = daysBetween(today, expiresAt);
    const kind = daysLeft < 0 ? "expired" : daysLeft <= EXPIRY_WARNING_DAYS ? "expiring" : null;
    if (!kind) continue;

    // Dedupe marker: one notification per (employee, kind, expiry date).
    const marker = `form-expiry:${employee.id}:${kind}:${expiresAt}`;
    const existing = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(like(emailOutbox.bodyHtml, `%${marker}%`))
      .limit(1);
    if (existing[0]) continue;

    const rendered =
      kind === "expiring"
        ? tplFormExpiring(ctx, {
            contractorName: employee.legalName,
            taxForm: details.taxForm,
            expiresAt,
            daysLeft,
          })
        : tplFormExpired(ctx, {
            contractorName: employee.legalName,
            taxForm: details.taxForm,
            expiresAt,
          });
    const eventType =
      kind === "expiring" ? EVENT_TYPE.contractorFormExpiring : EVENT_TYPE.contractorFormExpired;
    for (const adminId of admins) {
      await db.insert(emailOutbox).values({
        userId: adminId,
        eventType,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}<!-- ${marker} -->`,
      });
    }
    if (kind === "expiring") result.expiring += 1;
    else result.expired += 1;
  }
  return result;
}
