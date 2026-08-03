/**
 * Recurring contractor invoices (spec 12) — templates that generate one
 * ordinary invoice per month into the normal Spec 10 approval queue
 * (status 'submitted', submitted_by NULL), plus the payment-due reminder
 * sweep. Generated invoices are indistinguishable from manual ones after
 * creation: approve → record payment stays a deliberate admin act (D22, §5).
 *
 * Idempotency (spec §2): the partial unique index on
 * contractor_invoices(recurring_template_id, recurring_period) is the hard
 * belt — a re-run or double tick can never duplicate; the template's
 * last_generated_period is the second guard, updated in the same transaction.
 *
 * Lifecycle (D25): edits change future generations only; pause = active=false;
 * end = ends_on (last period generated, then the template retires itself);
 * delete only before the first generation, afterwards pause/end only.
 */

import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  company,
  contractorInvoices,
  contractorRecurringInvoices,
  emailOutbox,
  employees,
} from "@payroll/db";
import {
  EVENT_TYPE,
  contractorRecurringGenerated as tplRecurringGenerated,
  contractorRecurringPaymentDue as tplPaymentDue,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ContractorServiceError } from "./service.js";

export type RecurringTemplateRow = typeof contractorRecurringInvoices.$inferSelect;
export type InvoiceDay = "last_day" | "fixed";

interface Deps {
  db: Db;
  config: AppConfig;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-07-31" → { year: 2026, month: 7, day: 31 }. */
function parseIso(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

/** "YYYY-MM" — the period identifier used by the idempotency guards. */
export function periodKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** The invoice date a template produces for (year, month) — spec 12 §2/D24. */
export function invoiceDateFor(
  template: { invoiceDay: string; invoiceDayOfMonth: number | null },
  year: number,
  month: number,
): string {
  if (template.invoiceDay === "fixed") {
    return `${year}-${pad2(month)}-${pad2(template.invoiceDayOfMonth!)}`;
  }
  // Day 0 of the following month = last day of this month.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

/** {month} → 'July', {year} → '2026' (spec 12 §1/§2). */
export function interpolateDescription(description: string, year: number, month: number): string {
  return description
    .replaceAll("{month}", MONTH_NAMES[month - 1]!)
    .replaceAll("{year}", String(year));
}

/** "2000.00"/USD → "$2,000.00"; other currencies → "2,000.00 EUR". */
function amountLabel(amount: string, currency: string): string {
  const formatted = Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
}

async function templateCtx(db: Db, config: AppConfig): Promise<TemplateContext> {
  const rows = await db.select({ legalName: company.legalName }).from(company).limit(1);
  return { companyName: rows[0]?.legalName ?? "Payroll", appUrl: config.baseUrl };
}

async function adminUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

async function loadTemplate(db: Db, templateId: number): Promise<RecurringTemplateRow> {
  const rows = await db
    .select()
    .from(contractorRecurringInvoices)
    .where(eq(contractorRecurringInvoices.id, templateId))
    .limit(1);
  const template = rows[0];
  if (!template) {
    throw new ContractorServiceError("not_found", `recurring template ${templateId} not found`);
  }
  return template;
}

// ---------------------------------------------------------------------------
// Template CRUD (spec 12 §1, D25)
// ---------------------------------------------------------------------------

export interface RecurringTemplateInput {
  description: string;
  amount: number;
  currency?: string | undefined;
  invoiceDay: InvoiceDay;
  /** Required when invoiceDay='fixed'; cleared when 'last_day'. */
  invoiceDayOfMonth?: number | null | undefined;
  payDayOfMonth: number;
  startsOn: string;
  endsOn?: string | null | undefined;
}

export type RecurringTemplatePatch = {
  description?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  invoiceDay?: InvoiceDay | undefined;
  invoiceDayOfMonth?: number | null | undefined;
  payDayOfMonth?: number | undefined;
  startsOn?: string | undefined;
  endsOn?: string | null | undefined;
  active?: boolean | undefined;
};

interface ScheduleFields {
  description: string;
  amount: number | string;
  invoiceDay: string;
  invoiceDayOfMonth: number | null;
  payDayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
}

function validateDayRules(t: ScheduleFields): void {
  if (t.invoiceDay !== "last_day" && t.invoiceDay !== "fixed") {
    throw new ContractorServiceError("invalid_input", "invoiceDay must be 'last_day' or 'fixed'");
  }
  if (t.invoiceDay === "fixed" && (t.invoiceDayOfMonth == null || t.invoiceDayOfMonth < 1)) {
    throw new ContractorServiceError(
      "invalid_input",
      "invoiceDayOfMonth (1–28) is required when invoiceDay is 'fixed'",
    );
  }
  if (t.invoiceDayOfMonth != null && (t.invoiceDayOfMonth < 1 || t.invoiceDayOfMonth > 28)) {
    throw new ContractorServiceError("invalid_input", "invoiceDayOfMonth must be between 1 and 28");
  }
  if (t.payDayOfMonth < 1 || t.payDayOfMonth > 28) {
    throw new ContractorServiceError("invalid_input", "payDayOfMonth must be between 1 and 28");
  }
}

function validateDateRules(t: ScheduleFields): void {
  if (!DATE_RE.test(t.startsOn) || (t.endsOn !== null && !DATE_RE.test(t.endsOn))) {
    throw new ContractorServiceError("invalid_input", "startsOn/endsOn must be YYYY-MM-DD");
  }
  if (t.endsOn !== null && t.endsOn < t.startsOn) {
    throw new ContractorServiceError("invalid_input", "endsOn must be on or after startsOn");
  }
}

/** Cross-field schedule validation shared by create and update (spec §1 CHECKs). */
function validateSchedule(t: ScheduleFields): void {
  if (!t.description.trim()) {
    throw new ContractorServiceError("invalid_input", "description is required");
  }
  if (Number(t.amount) <= 0) {
    throw new ContractorServiceError("invalid_input", "amount must be positive");
  }
  validateDayRules(t);
  validateDateRules(t);
}

export async function createTemplate(
  deps: Deps,
  employeeId: number,
  input: RecurringTemplateInput,
  actorId: string,
): Promise<RecurringTemplateRow> {
  const { db } = deps;
  const contractorRows = await db
    .select({ employmentType: employees.employmentType })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  if (contractorRows[0]?.employmentType !== "1099") {
    throw new ContractorServiceError("not_found", `contractor ${employeeId} not found`);
  }
  const invoiceDayOfMonth = input.invoiceDay === "fixed" ? (input.invoiceDayOfMonth ?? null) : null;
  const values = {
    employeeId,
    description: input.description.trim(),
    amount: String(input.amount),
    currency: input.currency ?? "USD",
    invoiceDay: input.invoiceDay,
    invoiceDayOfMonth,
    payDayOfMonth: input.payDayOfMonth,
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
  };
  validateSchedule(values);

  return db.transaction(async (tx) => {
    const inserted = await tx.insert(contractorRecurringInvoices).values(values).returning();
    const template = inserted[0]!;
    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor_recurring.create",
      entity: "contractor_recurring_invoice",
      entityId: String(template.id),
      before: null,
      after: values,
    });
    return template;
  });
}

/**
 * Edit a template — future generations only (D25); invoices already
 * generated are untouched. active toggling covers pause/resume; setting
 * ends_on ends the template after that period.
 */
export async function updateTemplate(
  deps: Deps,
  templateId: number,
  input: RecurringTemplatePatch,
  actorId: string,
): Promise<RecurringTemplateRow> {
  const { db } = deps;
  const before = await loadTemplate(db, templateId);

  const merged = {
    description: input.description?.trim() ?? before.description,
    amount: input.amount !== undefined ? String(input.amount) : before.amount,
    invoiceDay: input.invoiceDay ?? before.invoiceDay,
    invoiceDayOfMonth:
      (input.invoiceDay ?? before.invoiceDay) === "fixed"
        ? input.invoiceDayOfMonth !== undefined
          ? input.invoiceDayOfMonth
          : before.invoiceDayOfMonth
        : null,
    payDayOfMonth: input.payDayOfMonth ?? before.payDayOfMonth,
    startsOn: input.startsOn ?? before.startsOn,
    endsOn: input.endsOn === undefined ? before.endsOn : input.endsOn,
  };
  validateSchedule(merged);

  const patch = {
    description: merged.description,
    amount: merged.amount,
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    invoiceDay: merged.invoiceDay,
    invoiceDayOfMonth: merged.invoiceDayOfMonth,
    payDayOfMonth: merged.payDayOfMonth,
    startsOn: merged.startsOn,
    endsOn: merged.endsOn,
    ...(input.active !== undefined ? { active: input.active } : {}),
    updatedAt: new Date(),
  };

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(contractorRecurringInvoices)
      .set(patch)
      .where(eq(contractorRecurringInvoices.id, templateId))
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor_recurring.update",
      entity: "contractor_recurring_invoice",
      entityId: String(templateId),
      before: {
        description: before.description,
        amount: before.amount,
        invoiceDay: before.invoiceDay,
        invoiceDayOfMonth: before.invoiceDayOfMonth,
        payDayOfMonth: before.payDayOfMonth,
        active: before.active,
        startsOn: before.startsOn,
        endsOn: before.endsOn,
      },
      after: patch,
    });
    return updated[0]!;
  });
}

/**
 * Delete is allowed only before the first generation (D25) — afterwards the
 * template is audit trail: pause (active=false) or end (ends_on) instead.
 */
export async function deleteTemplate(
  deps: Deps,
  templateId: number,
  actorId: string,
): Promise<void> {
  const { db } = deps;
  const template = await loadTemplate(db, templateId);
  const generated = await db
    .select({ id: contractorInvoices.id })
    .from(contractorInvoices)
    .where(eq(contractorInvoices.recurringTemplateId, templateId))
    .limit(1);
  if (template.lastGeneratedPeriod !== null || generated[0]) {
    throw new ContractorServiceError(
      "invalid_transition",
      "cannot delete a template after its first generation — pause or end it instead",
    );
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(contractorRecurringInvoices)
      .where(eq(contractorRecurringInvoices.id, templateId));
    await tx.insert(auditEvents).values({
      actorId,
      action: "contractor_recurring.delete",
      entity: "contractor_recurring_invoice",
      entityId: String(templateId),
      before: {
        employeeId: template.employeeId,
        description: template.description,
        amount: template.amount,
      },
      after: null,
    });
  });
}

/** Whether `date` (for `period`) is a generation candidate at/after `today`. */
function isGenerationCandidate(
  template: RecurringTemplateRow,
  date: string,
  period: string,
  today: string,
): boolean {
  if (date < today) return false;
  if (template.lastGeneratedPeriod && period <= template.lastGeneratedPeriod) return false;
  if (date < template.startsOn) return false;
  if (template.endsOn && date > template.endsOn) return false;
  return true;
}

/** Next invoice date at or after `today`; null when paused/ended/exhausted. */
export function nextGenerationOn(template: RecurringTemplateRow, today: string): string | null {
  if (!template.active) return null;
  const { year, month } = parseIso(today);
  for (const offset of [0, 1]) {
    const m = month + offset;
    const y = year + (m > 12 ? 1 : 0);
    const mm = m > 12 ? m - 12 : m;
    const date = invoiceDateFor(template, y, mm);
    if (isGenerationCandidate(template, date, periodKey(y, mm), today)) return date;
  }
  return null;
}

export async function listTemplates(
  deps: Deps,
  employeeId: number,
  opts: { today?: string } = {},
): Promise<(RecurringTemplateRow & { nextGenerationOn: string | null })[]> {
  const today = opts.today ?? todayIso();
  const rows = await deps.db
    .select()
    .from(contractorRecurringInvoices)
    .where(eq(contractorRecurringInvoices.employeeId, employeeId))
    .orderBy(asc(contractorRecurringInvoices.id));
  return rows.map((t) => ({ ...t, nextGenerationOn: nextGenerationOn(t, today) }));
}

// ---------------------------------------------------------------------------
// Generation tick (spec 12 §2) — the separate scheduler's daily work
// ---------------------------------------------------------------------------

/** Retire a template whose contract end has passed (spec §1: "retires itself"). */
async function retireTemplate(db: Db, template: RecurringTemplateRow): Promise<void> {
  await db
    .update(contractorRecurringInvoices)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(contractorRecurringInvoices.id, template.id));
  await db.insert(auditEvents).values({
    actorId: "scheduler",
    action: "contractor_recurring.retire",
    entity: "contractor_recurring_invoice",
    entityId: String(template.id),
    before: { active: true },
    after: { active: false, endsOn: template.endsOn },
  });
}

type GenerateOutcome = "generated" | "retired" | "skipped";

/**
 * Generate one invoice for a template whose period invoice date is today.
 * The unique index on (recurring_template_id, recurring_period) makes a
 * concurrent or repeated run a no-op; last_generated_period is updated in
 * the same transaction. `legalName` is read before the transaction (PGlite
 * runs the app single-connection — no non-tx reads mid-transaction).
 */
async function generateOne(
  deps: Deps,
  template: RecurringTemplateRow,
  legalName: string,
  ctx: TemplateContext,
  admins: string[],
  today: string,
): Promise<GenerateOutcome> {
  const { db } = deps;
  const { year, month } = parseIso(today);
  const period = periodKey(year, month);
  if (template.lastGeneratedPeriod === period) return "skipped";
  const invoiceDate = invoiceDateFor(template, year, month);
  if (invoiceDate < template.startsOn) return "skipped";
  if (template.endsOn && invoiceDate > template.endsOn) {
    await retireTemplate(db, template);
    return "retired";
  }
  const description = interpolateDescription(template.description, year, month);

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contractorInvoices)
      .values({
        employeeId: template.employeeId,
        description,
        amount: template.amount,
        currency: template.currency,
        invoiceDate,
        status: "submitted",
        submittedBy: null,
        recurringTemplateId: template.id,
        recurringPeriod: period,
      })
      .onConflictDoNothing()
      .returning({ id: contractorInvoices.id });
    const invoice = inserted[0];
    if (!invoice) return false; // index belt: already generated for this period

    const retire = template.endsOn !== null && template.endsOn <= invoiceDate;
    await tx
      .update(contractorRecurringInvoices)
      .set({
        lastGeneratedPeriod: period,
        ...(retire ? { active: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(contractorRecurringInvoices.id, template.id));

    await tx.insert(auditEvents).values({
      actorId: "scheduler",
      action: "contractor_recurring.generate",
      entity: "contractor_invoice",
      entityId: String(invoice.id),
      before: null,
      after: { templateId: template.id, period, description, invoiceDate },
    });

    const rendered = tplRecurringGenerated(ctx, {
      contractorName: legalName,
      amountLabel: amountLabel(template.amount, template.currency),
      periodLabel: `${MONTH_NAMES[month - 1]!} ${year}`,
      description,
    });
    for (const adminId of admins) {
      await tx.insert(emailOutbox).values({
        userId: adminId,
        eventType: EVENT_TYPE.contractorRecurringGenerated,
        subject: rendered.subject,
        bodyHtml: rendered.html,
      });
    }
    return true;
  });
  return created ? "generated" : "skipped";
}

/**
 * The daily generation tick: for each active template whose period invoice
 * date is today, generate one 'submitted' invoice (D22) and notify admins.
 * Idempotent — safe to run any number of times per day.
 */
export async function generateRecurringInvoices(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ generated: number; retired: number }> {
  const today = opts.today ?? todayIso();
  const { year, month } = parseIso(today);
  const templates = await deps.db
    .select({ template: contractorRecurringInvoices, legalName: employees.legalName })
    .from(contractorRecurringInvoices)
    .innerJoin(employees, eq(employees.id, contractorRecurringInvoices.employeeId))
    .where(eq(contractorRecurringInvoices.active, true))
    .orderBy(asc(contractorRecurringInvoices.id));

  const due = templates.filter((t) => invoiceDateFor(t.template, year, month) === today);
  if (due.length === 0) return { generated: 0, retired: 0 };

  const ctx = await templateCtx(deps.db, deps.config);
  const admins = await adminUserIds(deps.db);
  const result = { generated: 0, retired: 0 };
  for (const { template, legalName } of due) {
    const outcome = await generateOne(deps, template, legalName, ctx, admins, today);
    if (outcome === "generated") result.generated += 1;
    else if (outcome === "retired") result.retired += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Payment-due sweep (spec 12 §3) — W-8-expiry-sweep pattern
// ---------------------------------------------------------------------------

/**
 * On a template's pay_day_of_month (of the month following the invoice
 * period), if the generated invoice is approved but unpaid → one admin
 * notification per invoice per day, idempotent via an outbox marker. A
 * recorded payment (or rejection/void) suppresses the reminder entirely.
 */
export async function paymentDueSweep(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ due: number }> {
  const today = opts.today ?? todayIso();
  const { year, month, day } = parseIso(today);
  const templates = await deps.db
    .select()
    .from(contractorRecurringInvoices)
    .where(eq(contractorRecurringInvoices.payDayOfMonth, day))
    .orderBy(asc(contractorRecurringInvoices.id));
  if (templates.length === 0) return { due: 0 };

  // The invoice period is the month BEFORE the pay month.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const period = periodKey(prevYear, prevMonth);

  const ctx = await templateCtx(deps.db, deps.config);
  const admins = await adminUserIds(deps.db);
  let due = 0;

  for (const template of templates) {
    const rows = await deps.db
      .select({ invoice: contractorInvoices, legalName: employees.legalName })
      .from(contractorInvoices)
      .innerJoin(employees, eq(employees.id, contractorInvoices.employeeId))
      .where(
        and(
          eq(contractorInvoices.recurringTemplateId, template.id),
          eq(contractorInvoices.recurringPeriod, period),
        ),
      )
      .limit(1);
    const row = rows[0];
    // Approved-but-unpaid only: paid/rejected/void (or never generated) never fire.
    if (row?.invoice.status !== "approved") continue;

    // Dedupe marker: one notification per invoice per day.
    const marker = `payment-due:${row.invoice.id}:${today}`;
    const existing = await deps.db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(like(emailOutbox.bodyHtml, `%${marker}%`))
      .limit(1);
    if (existing[0]) continue;

    const rendered = tplPaymentDue(ctx, {
      contractorName: row.legalName,
      amountLabel: amountLabel(row.invoice.amount, row.invoice.currency),
      description: row.invoice.description,
    });
    for (const adminId of admins) {
      await deps.db.insert(emailOutbox).values({
        userId: adminId,
        eventType: EVENT_TYPE.contractorRecurringPaymentDue,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}<!-- ${marker} -->`,
      });
    }
    due += 1;
  }
  return { due };
}
