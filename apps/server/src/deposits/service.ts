/**
 * Monthly federal tax deposits (PAY-9) — computed schedule, due-date
 * reminders, deposit tracking. Record-only (D3): EFTPS has no API, so the app
 * computes the amount, reminds admins, and records the deposit date +
 * confirmation number; the payment itself always happens on eftps.gov.
 *
 * Monthly-depositor rule: the deposit for a month = employee
 * federal_withholding + social_security + medicare + employer_social_security
 * + employer_medicare across ISSUED payroll runs with pay_date in that month
 * (frozen entry snapshots, never live config — recomputation reproduces the
 * same amount to the cent). employer_futa is Form 940, out of scope. Due the
 * 15th of the following month, rolled forward off weekends (federal-holiday
 * roll deferred, V1).
 *
 * Jurisdiction-ready (D2): jurisdiction is 'federal' today; state rows
 * activate with PAY-13. The (jurisdiction, period_start) unique constraint
 * makes the daily sync idempotent.
 *
 * All business logic lives here and is integration-tested WITHOUT pg-boss
 * (which needs a real Postgres) — payroll/scheduler.ts only wires the queue.
 */

import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  authUser,
  company,
  emailOutbox,
  payrollEntries,
  payrollRuns,
  taxDeposits,
} from "@payroll/db";
import { formatMoney } from "@payroll/shared";
import {
  EVENT_TYPE,
  taxDepositDue as tplTaxDepositDue,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";

export type TaxDepositRow = typeof taxDeposits.$inferSelect;

export class DepositServiceError extends Error {
  constructor(
    public code: "not_found" | "invalid_input" | "invalid_transition",
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  db: Db;
  config: AppConfig;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Entry categories summed into the monthly deposit (NOT employer_futa). */
export const DEPOSIT_CATEGORIES = [
  "federal_withholding",
  "social_security",
  "medicare",
  "employer_social_security",
  "employer_medicare",
] as const;

/** D1: default reminder offsets (days before the due date) — the 10th + due day. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [5, 0];
export const REMINDER_OFFSETS_SETTING_KEY = "tax_deposit_reminder_offsets";
export const REMINDER_OFFSET_MAX = 30;
export const REMINDER_OFFSET_MAX_ENTRIES = 10;

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

/** First of the month as "YYYY-MM-DD" (the period key for a deposit month). */
export function periodStartFor(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`;
}

/** UTC-safe day arithmetic on ISO dates (no server-local timezone leakage). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Due date for the deposit covering `year`-`month`: the 15th of the FOLLOWING
 * month, rolled forward to the next business day when it lands on a weekend
 * (federal-holiday roll is out of scope for V1). All math in UTC.
 */
export function dueDateFor(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 15)); // month is 1-based → next month
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** "August 2026" — display label for a deposit period. */
export function periodLabel(periodStart: string): string {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  return `${MONTH_NAMES[month - 1] ?? periodStart} ${year}`;
}

/**
 * The deposit amount for a month: the five deposit categories summed across
 * ISSUED runs with pay_date in the month. Draft/void/awaiting runs never
 * count. NUMERIC sum in SQL — exact decimal math, no floats, to the cent.
 */
export async function computeDepositAmount(db: Db, year: number, month: number): Promise<string> {
  const periodStart = periodStartFor(year, month);
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        sql`${payrollEntries.category} IN (${sql.join(
          DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
          sql`, `,
        )})`,
      ),
    );
  return rows[0]?.total ?? "0.00";
}

// ---------------------------------------------------------------------------
// Reminder-offsets setting (D1 — admin-editable, app_settings key/value row)
// ---------------------------------------------------------------------------

function isValidOffsets(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= REMINDER_OFFSET_MAX_ENTRIES &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= REMINDER_OFFSET_MAX)
  );
}

/** Stored offsets, or the D1 default [5, 0] when no row exists yet. */
export async function getReminderOffsets(db: Db): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, REMINDER_OFFSETS_SETTING_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return isValidOffsets(value) ? [...value].sort((a, b) => b - a) : [...DEFAULT_REMINDER_OFFSETS];
}

/** Persist a new reminder schedule (audit-logged like every admin mutation). */
export async function setReminderOffsets(
  deps: Deps,
  offsets: number[],
  actorId: string,
): Promise<number[]> {
  const { db } = deps;
  if (!isValidOffsets(offsets)) {
    throw new DepositServiceError(
      "invalid_input",
      `offsets must be 1-${REMINDER_OFFSET_MAX_ENTRIES} integers between 0 and ${REMINDER_OFFSET_MAX}`,
    );
  }
  const normalized = [...new Set(offsets)].sort((a, b) => b - a);
  const before = await getReminderOffsets(db);
  await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({ key: REMINDER_OFFSETS_SETTING_KEY, value: normalized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [appSettings.key],
        set: { value: normalized, updatedAt: new Date() },
      });
    await tx.insert(auditEvents).values({
      actorId,
      action: "settings.tax_deposit_reminders",
      entity: "app_settings",
      entityId: REMINDER_OFFSETS_SETTING_KEY,
      before: { offsets: before },
      after: { offsets: normalized },
    });
  });
  return normalized;
}

// ---------------------------------------------------------------------------
// Deposit sync (daily tick) — idempotent upsert + overdue flip
// ---------------------------------------------------------------------------

export interface SyncResult {
  created: number;
  recomputed: number;
  flippedOverdue: number;
}

/**
 * Upsert pending deposit rows for every month with issued payroll history —
 * INCLUDING the current month (PAY-14): the row appears as soon as a run
 * issues in the month, because the FTD is typically paid right after payroll,
 * weeks before the due date. Then flip past-due pending rows to 'overdue'.
 * Idempotent: the (jurisdiction, period_start) unique constraint is the belt;
 * amounts are recomputed while status='pending' so a late-issued run corrects
 * the figure, and 'deposited'/'overdue' rows are never rewritten. Due dates,
 * the overdue flip, and reminders are all relative to the 15th of the
 * FOLLOWING month, so a current-month row is never overdue and never reminds.
 */
export async function syncDeposits(deps: Deps, opts: { today?: string } = {}): Promise<SyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();

  const months = await db
    .selectDistinct({
      periodStart: sql<string>`to_char(date_trunc('month', ${payrollRuns.payDate})::date, 'YYYY-MM-DD')`,
    })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"))
    .orderBy(sql`1`);

  const result: SyncResult = { created: 0, recomputed: 0, flippedOverdue: 0 };

  for (const { periodStart } of months) {
    const year = Number(periodStart.slice(0, 4));
    const month = Number(periodStart.slice(5, 7));
    const amount = await computeDepositAmount(db, year, month);
    const dueDate = dueDateFor(year, month);

    const existing = await db
      .select()
      .from(taxDeposits)
      .where(and(eq(taxDeposits.jurisdiction, "federal"), eq(taxDeposits.periodStart, periodStart)))
      .limit(1);
    const row = existing[0];

    if (!row) {
      await db.insert(taxDeposits).values({
        jurisdiction: "federal",
        periodStart,
        amount,
        dueDate,
        status: "pending",
        createdBy: "scheduler",
      });
      result.created += 1;
      continue;
    }
    if (row.status === "pending" && row.amount !== amount) {
      await db
        .update(taxDeposits)
        .set({ amount, updatedAt: new Date() })
        .where(eq(taxDeposits.id, row.id));
      result.recomputed += 1;
    }
  }

  const flipped = await db
    .update(taxDeposits)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(and(eq(taxDeposits.status, "pending"), lt(taxDeposits.dueDate, today)))
    .returning({ id: taxDeposits.id });
  result.flippedOverdue = flipped.length;

  return result;
}

// ---------------------------------------------------------------------------
// Admin queries + the mark-deposited mutation
// ---------------------------------------------------------------------------

/** Deposits, newest period first (admin list). PAY-15: optional year/status filters. */
export async function listDeposits(
  db: Db,
  filter: {
    year?: number | undefined;
    status?: "pending" | "deposited" | "overdue" | undefined;
  } = {},
): Promise<TaxDepositRow[]> {
  const conditions = [];
  if (filter.year) {
    conditions.push(
      and(
        sql`${taxDeposits.periodStart} >= ${`${filter.year}-01-01`}`,
        sql`${taxDeposits.periodStart} <= ${`${filter.year}-12-31`}`,
      ),
    );
  }
  if (filter.status) conditions.push(eq(taxDeposits.status, filter.status));
  return db
    .select()
    .from(taxDeposits)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(taxDeposits.periodStart), desc(taxDeposits.id));
}

export interface MarkDepositedInput {
  depositedOn: string;
  eftpsConfirmation: string;
}

/**
 * Record an EFTPS deposit (D3 record-only). Depositing is idempotent per row:
 * an already-deposited row rejects with invalid_transition. Audit-logged in
 * the same transaction.
 */
export async function markDeposited(
  deps: Deps,
  depositId: number,
  input: MarkDepositedInput,
  actorId: string,
): Promise<TaxDepositRow> {
  const { db } = deps;
  if (!DATE_RE.test(input.depositedOn)) {
    throw new DepositServiceError("invalid_input", "depositedOn must be YYYY-MM-DD");
  }
  const confirmation = input.eftpsConfirmation.trim();
  if (!confirmation || confirmation.length > 100) {
    throw new DepositServiceError(
      "invalid_input",
      "eftpsConfirmation is required (max 100 characters)",
    );
  }

  const rows = await db.select().from(taxDeposits).where(eq(taxDeposits.id, depositId)).limit(1);
  const before = rows[0];
  if (!before) {
    throw new DepositServiceError("not_found", `tax deposit ${depositId} not found`);
  }
  if (before.status === "deposited") {
    throw new DepositServiceError("invalid_transition", "deposit is already recorded");
  }

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(taxDeposits)
      .set({
        status: "deposited",
        depositedOn: input.depositedOn,
        eftpsConfirmation: confirmation,
        updatedAt: new Date(),
      })
      .where(eq(taxDeposits.id, depositId))
      .returning();

    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_deposit.deposit",
      entity: "tax_deposit",
      entityId: String(depositId),
      before: { status: before.status, amount: before.amount, dueDate: before.dueDate },
      after: {
        status: "deposited",
        depositedOn: input.depositedOn,
        eftpsConfirmation: confirmation,
      },
    });
    return updated[0]!;
  });
}

// ---------------------------------------------------------------------------
// Due-date reminders (D1) — each configured offset fires at most once
// ---------------------------------------------------------------------------

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

/**
 * Send due-date reminders: for every undeposited row and every configured
 * offset, mail all admins when today == due_date − offset and that offset has
 * not fired yet. reminders_sent is the dedupe record — re-ticks never
 * double-mail, and each offset fires at most once per deposit.
 */
export async function sendDepositReminders(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const offsets = await getReminderOffsets(db);

  const deposits = await db
    .select()
    .from(taxDeposits)
    .where(ne(taxDeposits.status, "deposited"))
    .orderBy(taxDeposits.periodStart);
  if (deposits.length === 0) return { sent: 0 };

  const ctx = await templateCtx(db, config);
  const admins = await adminUserIds(db);
  let sent = 0;

  for (const deposit of deposits) {
    const fired = new Set((deposit.remindersSent as number[] | null) ?? []);
    for (const offset of offsets) {
      if (fired.has(offset)) continue;
      if (addDays(deposit.dueDate, -offset) !== today) continue;

      const rendered = tplTaxDepositDue(ctx, {
        jurisdiction: deposit.jurisdiction,
        periodLabel: periodLabel(deposit.periodStart),
        amountLabel: formatMoney(Number(deposit.amount)),
        dueDate: deposit.dueDate,
      });
      const marker = `deposit-reminder:${deposit.id}:${offset}`;
      for (const adminId of admins) {
        await db.insert(emailOutbox).values({
          userId: adminId,
          eventType: EVENT_TYPE.taxDepositDue,
          subject: rendered.subject,
          bodyHtml: `${rendered.html}<!-- ${marker} -->`,
        });
      }
      await db
        .update(taxDeposits)
        .set({ remindersSent: [...fired, offset], updatedAt: new Date() })
        .where(eq(taxDeposits.id, deposit.id));
      fired.add(offset);
      sent += 1;
    }
  }
  return { sent };
}
