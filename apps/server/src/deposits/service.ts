/**
 * Monthly tax deposits (PAY-9 federal, PAY-47 state) — computed schedule,
 * due-date reminders, deposit tracking. Record-only (D3): EFTPS has no API,
 * so the app computes the amount, reminds admins, and records the deposit
 * date + confirmation number; the payment itself always happens on
 * eftps.gov (or the state equivalent).
 *
 * Monthly-depositor rule: the federal deposit for a month = employee
 * federal_withholding + social_security + medicare + employer_social_security
 * + employer_medicare across ISSUED payroll runs with pay_date in that month
 * (frozen entry snapshots, never live config — recomputation reproduces the
 * same amount to the cent). employer_futa is Form 940, out of scope. Due the
 * 15th of the following month, rolled forward off weekends (federal-holiday
 * roll deferred, V1).
 *
 * State rows (PAY-47): one row per work state per month from the frozen run
 * snapshots (inputs.state.workState), amount = the month's state_withholding
 * sum for that state; states with zero withholding get no row. Same due-date
 * convention V1 (15th of the following month, informational — real per-state
 * schedules differ and are a future refinement). The (jurisdiction,
 * period_start) unique constraint makes the daily sync idempotent.
 *
 * All business logic lives here and is integration-tested WITHOUT pg-boss
 * (which needs a real Postgres) — payroll/scheduler.ts only wires the queue.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  authUser,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  stateDepositSchedules,
  taxDeposits,
} from "@payroll/db";
import { formatMoney, parseCents } from "@payroll/shared";
import {
  EVENT_TYPE,
  taxDepositDue as tplTaxDepositDue,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";

export interface TaxDepositWithPeriodKind extends TaxDepositRow {
  periodKind: PeriodKind;
}

export type TaxDepositRow = typeof taxDeposits.$inferSelect;

/** periodKind distinguishes monthly (m12) from quarterly (q4) deposits. */
export type PeriodKind = "month" | "quarter";

/**
 * Spec 23 §5: a "live" deposit row is any row that has not been replaced by a
 * period transition. EVERY total, list or sum over tax_deposits must filter
 * on this fragment — superseded rows are kept for audit and are never counted.
 */
export const liveDeposit = sql`${taxDeposits.status} <> 'superseded'`;

/** The stored period_kind column, narrowed (the DB check keeps it to these two). */
export function withPeriodKind(row: TaxDepositRow): TaxDepositWithPeriodKind {
  return { ...row, periodKind: row.periodKind === "quarter" ? "quarter" : "month" };
}

/** PAY-36 — detail payload for GET /api/admin/tax-deposits/:id. */
export interface DepositDetailRow {
  deposit: TaxDepositWithPeriodKind;
  breakdown: { category: string; amount: string }[];
  runs: { publicId: string; payDate: string; employeeName: string; amount: string }[];
}

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

/** "August 2026" / "Q3 2026" — display label for a deposit period (stored period_kind). */
export function periodLabel(periodStart: string, kind: PeriodKind = "month"): string {
  if (kind === "quarter") {
    const year = Number(periodStart.slice(0, 4));
    const q = quarterOfMonth(Number(periodStart.slice(5, 7)));
    return `Q${q} ${year}`;
  }
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  return `${MONTH_NAMES[month - 1] ?? periodStart} ${year}`;
}

/**
 * quarterOfMonth: map a month (1-12) to its quarter (1-4).
 * Jan-Mar = 1, Apr-Jun = 2, Jul-Sep = 3, Oct-Dec = 4.
 */
export function quarterOfMonth(month: number): number {
  return Math.ceil(month / 3);
}

/**
 * statePeriodStartFor: determine the period start for a given (year, month)
 * based on the schedule's frequency. Monthly or no schedule → monthly period
 * (first of the month). Quarterly → first of the quarter's first month.
 */
export function statePeriodStartFor(
  schedule: { frequency: "monthly" | "quarterly" } | null,
  year: number,
  month: number,
): string {
  if (!schedule || schedule.frequency === "monthly") {
    return periodStartFor(year, month);
  }
  const q = quarterOfMonth(month);
  const firstMonthOfQuarter = (q - 1) * 3 + 1;
  return periodStartFor(year, firstMonthOfQuarter);
}

/**
 * stateDueDateFor: compute the due date for a period start, given a schedule.
 * No schedule → federal convention (monthly, 15th following month, weekend roll).
 * Monthly → dueDay of following month (or last day if NULL).
 * Quarterly → dueDay of month following quarter's end (or last day if NULL).
 * All math UTC, weekend roll-forward only.
 */
export function stateDueDateFor(
  schedule: { frequency: "monthly" | "quarterly"; dueDay?: number | null } | null,
  _year: number,
  periodStart: string,
): string {
  // Use the year from periodStart, not the passed year parameter
  const year = Number(periodStart.slice(0, 4));
  if (!schedule) {
    const m = Number(periodStart.slice(5, 7));
    return dueDateFor(year, m);
  }
  if (schedule.frequency === "monthly") {
    const month = Number(periodStart.slice(5, 7));
    const dueMonth = month === 12 ? 1 : month + 1;
    const dueYear = month === 12 ? year + 1 : year;
    const dueDay = schedule.dueDay ?? daysInMonth(dueYear, dueMonth);
    return dueDateForDay(dueYear, dueMonth, dueDay);
  }
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const lastMonthOfQuarter = quarter * 3;
  const dueMonth = lastMonthOfQuarter === 12 ? 1 : lastMonthOfQuarter + 1;
  const dueYear = lastMonthOfQuarter === 12 ? year + 1 : year;
  const dueDay = schedule.dueDay ?? daysInMonth(dueYear, dueMonth);
  return dueDateForDay(dueYear, dueMonth, dueDay);
}

function daysInMonth(year: number, month: number): number {
  // month is 1-indexed (1=Jan, 12=Dec)
  // Use UTC to avoid timezone issues
  // Date(year, month, 0) gives last day of (month-1) in 0-indexed terms
  // daysInMonth(2026, 10) = last day of October = 31
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate();
}

function dueDateForDay(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
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

/**
 * Compute per-state sums for state_withholding entries across all issued
 * runs in a month. Returns an array of {workState, amount} for each distinct
 * workState with non-zero state withholding. Runs without a frozen
 * inputs.state (legacy / no work state) group under a NULL workState — they
 * necessarily sum to 0.00 and are dropped by the zero filter.
 */
export async function computeStateDepositAmounts(
  db: Db,
  year: number,
  month: number,
): Promise<{ workState: string; amount: string }[]> {
  const periodStart = periodStartFor(year, month);
  const rows = await db
    .select({
      workState: sql<string>`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}')`,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        eq(payrollEntries.category, "state_withholding"),
      ),
    )
    .groupBy(sql`${payrollRuns.runSnapshot}#>>'{inputs,state,workState}'`);

  return rows
    .filter((row) => row.workState && row.amount !== "0.00")
    .map((row) => ({ workState: row.workState, amount: row.amount }));
}

/**
 * Compute per-state sums for state_withholding entries across all issued
 * runs in a period (monthly or quarterly). Returns an array of
 * {periodStart, workState, amount}. For quarterly schedules, aggregates across
 * the entire quarter; for monthly/fallback, only the given periodStart month.
 */
export async function computeStateDepositAmountsForPeriod(
  db: Db,
  periodStart: string,
  frequency: "monthly" | "quarterly",
): Promise<{ workState: string; amount: string }[]> {
  let periodClause: SQLWrapper | undefined;
  if (frequency === "monthly") {
    periodClause = sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`;
  } else {
    const q = quarterOfMonth(Number(periodStart.slice(5, 7)));
    const firstMonth = (q - 1) * 3 + 1;
    const lastMonth = q * 3;
    const firstPeriod = periodStartFor(Number(periodStart.slice(0, 4)), firstMonth);
    const lastPeriod = periodStartFor(Number(periodStart.slice(0, 4)), lastMonth);
    periodClause = sql`
      date_trunc('month', ${payrollRuns.payDate})::date >= ${firstPeriod}::date
      AND date_trunc('month', ${payrollRuns.payDate})::date <= ${lastPeriod}::date
    `;
  }
  const rows = await db
    .select({
      workState: sql<string>`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}')`,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        periodClause,
        eq(payrollEntries.category, "state_withholding"),
      ),
    )
    .groupBy(sql`${payrollRuns.runSnapshot}#>>'{inputs,state,workState}'`);

  return rows
    .filter((row) => row.workState && row.amount !== "0.00")
    .map((row) => ({ workState: row.workState, amount: row.amount }));
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

interface StateSchedule {
  frequency: "monthly" | "quarterly";
  dueDay: number | null;
}

function toStateSchedule(row: typeof stateDepositSchedules.$inferSelect): StateSchedule {
  const frequency = row.frequency as "monthly" | "quarterly";
  return {
    frequency,
    dueDay: row.dueDay,
  };
}

/** Load all state deposit schedules into a Map keyed by "stateCode:taxYear". */
async function loadStateSchedules(db: Db): Promise<Map<string, StateSchedule>> {
  const rows = await db.select().from(stateDepositSchedules);
  const map = new Map<string, StateSchedule>();
  for (const row of rows) {
    const key = `${row.stateCode}:${row.taxYear}`;
    map.set(key, toStateSchedule(row));
  }
  return map;
}

/** Compute the period key for a (state, periodStart, schedule). */
function statePeriodKey(
  state: string,
  periodStart: string,
  schedule: StateSchedule | null,
): string {
  if (!schedule || schedule.frequency === "monthly") {
    return `${state}:${periodStart}`;
  }
  const year = Number(periodStart.slice(0, 4));
  const q = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const firstMonthOfQuarter = (q - 1) * 3 + 1;
  const quarterStart = periodStartFor(year, firstMonthOfQuarter);
  return `${state}:${quarterStart}`;
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
 * the overdue flip, and reminders use the per-state schedule when present.
 *
 * After the federal loop, state rows are synced once per distinct (state,
 * periodStart), where periodStart is the state's deposit period (monthly for
 * monthly frequency, or quarter start for quarterly frequency).
 */
async function syncFederalDeposit(db: Db, periodStart: string, result: SyncResult) {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const amount = await computeDepositAmount(db, year, month);
  const dueDate = dueDateFor(year, month);

  const existing = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, "federal"),
        eq(taxDeposits.periodStart, periodStart),
        eq(taxDeposits.periodKind, "month"),
        liveDeposit,
      ),
    )
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
    return;
  }
  if (row.status === "pending" && row.amount !== amount) {
    await db
      .update(taxDeposits)
      .set({ amount, updatedAt: new Date() })
      .where(eq(taxDeposits.id, row.id));
    result.recomputed += 1;
  }
}

async function syncStateDepositsForPeriod(
  db: Db,
  workState: string,
  periodStart: string,
  schedule: StateSchedule | null,
  result: SyncResult,
) {
  const stateDeposits = await computeStateDepositAmountsForPeriod(
    db,
    periodStart,
    schedule?.frequency ?? "monthly",
  );

  let totalAmount = "0.00";
  for (const { workState: ws, amount } of stateDeposits) {
    if (ws === workState) {
      totalAmount = amount;
      break;
    }
  }

  const periodKind: PeriodKind = schedule?.frequency === "quarterly" ? "quarter" : "month";
  const existing = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, workState),
        eq(taxDeposits.periodStart, periodStart),
        eq(taxDeposits.periodKind, periodKind),
        liveDeposit,
      ),
    )
    .limit(1);
  const row = existing[0];

  if (!row) {
    await db.insert(taxDeposits).values({
      jurisdiction: workState,
      periodStart,
      periodKind,
      amount: totalAmount,
      dueDate: stateDueDateFor(schedule, Number(periodStart.slice(0, 4)), periodStart),
      status: "pending",
      createdBy: "scheduler",
    });
    result.created += 1;
  } else if (row.status === "pending" && row.amount !== totalAmount) {
    await db
      .update(taxDeposits)
      .set({ amount: totalAmount, updatedAt: new Date() })
      .where(eq(taxDeposits.id, row.id));
    result.recomputed += 1;
  }
}

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

  const scheduleMap = await loadStateSchedules(db);
  const result: SyncResult = { created: 0, recomputed: 0, flippedOverdue: 0 };

  for (const { periodStart } of months) {
    await syncFederalDeposit(db, periodStart, result);
  }

  const statePeriods = new Map<
    string,
    { workState: string; periodStart: string; schedule: StateSchedule | null }
  >();

  for (const { periodStart } of months) {
    const year = Number(periodStart.slice(0, 4));
    const month = Number(periodStart.slice(5, 7));
    const stateAmounts = await computeStateDepositAmounts(db, year, month);

    for (const { workState } of stateAmounts) {
      const scheduleKey = `${workState}:${year}`;
      const schedule = scheduleMap.get(scheduleKey) ?? null;
      const periodKey = statePeriodKey(workState, periodStart, schedule);
      const effectivePeriodStart = statePeriodStartFor(schedule, year, month);

      if (!statePeriods.has(periodKey)) {
        statePeriods.set(periodKey, { workState, periodStart: effectivePeriodStart, schedule });
      }
    }
  }

  for (const { workState, periodStart, schedule } of statePeriods.values()) {
    await syncStateDepositsForPeriod(db, workState, periodStart, schedule, result);
  }

  const flipped = await db
    .update(taxDeposits)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        eq(taxDeposits.status, "pending"),
        lt(taxDeposits.dueDate, today),
        sql`${taxDeposits.amount} > 0`,
      ),
    )
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
    jurisdiction?: string | undefined;
  } = {},
): Promise<TaxDepositWithPeriodKind[]> {
  const conditions: SQLWrapper[] = [liveDeposit];
  if (filter.year) {
    conditions.push(sql`${taxDeposits.periodStart} >= ${`${filter.year}-01-01`}`);
    conditions.push(sql`${taxDeposits.periodStart} <= ${`${filter.year}-12-31`}`);
  }
  if (filter.status) conditions.push(eq(taxDeposits.status, filter.status));
  if (filter.jurisdiction) conditions.push(eq(taxDeposits.jurisdiction, filter.jurisdiction));
  const rows = await db
    .select()
    .from(taxDeposits)
    .where(and(...conditions))
    .orderBy(desc(taxDeposits.periodStart), desc(taxDeposits.id));
  return rows.map(withPeriodKind);
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
): Promise<TaxDepositWithPeriodKind> {
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
  // Spec 23 §5 / D5: a replaced row, or a 0.00 row, has nothing to pay.
  if (before.status === "superseded" || parseCents(before.amount) === 0) {
    throw new DepositServiceError("invalid_transition", "This deposit has nothing left to record.");
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
      .where(
        and(eq(taxDeposits.id, depositId), inArray(taxDeposits.status, ["pending", "overdue"])),
      )
      .returning();
    const row = updated[0];
    if (!row) {
      // Lost a race with the sync (superseded) or another recorder.
      throw new DepositServiceError(
        "invalid_transition",
        "This deposit has nothing left to record.",
      );
    }

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
    return withPeriodKind(row);
  });
}

// ---------------------------------------------------------------------------
// Due-date reminders (D1) — each configured offset fires at most once
// ---------------------------------------------------------------------------

async function adminUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

async function processDepositReminders(
  db: Db,
  ctx: TemplateContext,
  admins: string[],
  deposit: TaxDepositRow,
  offsets: number[],
  today: string,
): Promise<number> {
  const periodStart = deposit.periodStart;
  const { periodKind } = withPeriodKind(deposit);

  let sent = 0;
  const fired = new Set((deposit.remindersSent as number[] | null) ?? []);

  for (const offset of offsets) {
    if (fired.has(offset)) continue;
    if (addDays(deposit.dueDate, -offset) !== today) continue;

    const rendered = tplTaxDepositDue(ctx, {
      jurisdiction: deposit.jurisdiction,
      periodLabel: periodLabel(periodStart, periodKind),
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
  return sent;
}

/**
 * Send due-date reminders: for every undeposited row and every configured
 * offset, mail all admins when today == due_date − offset and that offset has
 * not fired yet. reminders_sent is the dedupe record — re-ticks never
 * double-mail, and each offset fires at most once per deposit.
 *
 * For quarterly state deposits, the period label shows Q<quarter> <year>.
 */
export async function sendDepositReminders(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const offsets = await getReminderOffsets(db);

  // Spec 23 §5 / D5: only open rows with something to pay are reminded.
  const deposits = await db
    .select()
    .from(taxDeposits)
    .where(and(inArray(taxDeposits.status, ["pending", "overdue"]), sql`${taxDeposits.amount} > 0`))
    .orderBy(taxDeposits.periodStart);
  if (deposits.length === 0) return { sent: 0 };

  const ctx = await templateContext(db, config);
  const admins = await adminUserIds(db);
  let totalSent = 0;

  for (const deposit of deposits) {
    const sent = await processDepositReminders(db, ctx, admins, deposit, offsets, today);
    totalSent += sent;
  }
  return { sent: totalSent };
}

async function getFederalOrMonthlyDepositDetail(
  db: Db,
  deposit: TaxDepositRow,
  periodStart: string,
): Promise<DepositDetailRow> {
  let sqlCategoryFilter: SQLWrapper;

  if (deposit.jurisdiction === "federal") {
    sqlCategoryFilter = sql`${payrollEntries.category} IN (${sql.join(
      DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
      sql`, `,
    )})`;
  } else {
    sqlCategoryFilter = eq(payrollEntries.category, "state_withholding");
  }

  const breakdownRows = await db
    .select({
      category: payrollEntries.category,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        sqlCategoryFilter,
        ...(deposit.jurisdiction !== "federal"
          ? [
              sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
            ]
          : []),
      ),
    )
    .groupBy(payrollEntries.category);

  const breakdown: DepositDetailRow["breakdown"] = [];
  if (deposit.jurisdiction === "federal") {
    for (const category of DEPOSIT_CATEGORIES) {
      const row = breakdownRows.find((r) => r.category === category);
      breakdown.push({
        category,
        amount: row ? row.amount : "0.00",
      });
    }
  } else {
    const row = breakdownRows.find((r) => r.category === "state_withholding");
    breakdown.push({
      category: "state_withholding",
      amount: row ? row.amount : "0.00",
    });
  }

  const runsCategoryFilter =
    deposit.jurisdiction === "federal"
      ? sql`${payrollEntries.category} IN (${sql.join(
          DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
          sql`, `,
        )})`
      : eq(payrollEntries.category, "state_withholding");

  const runs = await db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      employeeName: employees.legalName,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollRuns)
    .innerJoin(payrollEntries, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        runsCategoryFilter,
        ...(deposit.jurisdiction !== "federal"
          ? [
              sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
            ]
          : []),
      ),
    )
    .groupBy(payrollRuns.publicId, payrollRuns.payDate, employees.legalName)
    .orderBy(payrollRuns.payDate);

  return {
    deposit: withPeriodKind(deposit),
    breakdown,
    runs: runs.map((row) => ({
      publicId: row.publicId,
      payDate: row.payDate,
      employeeName: row.employeeName,
      amount: row.amount,
    })),
  };
}

async function getQuarterlyDepositDetail(
  db: Db,
  deposit: TaxDepositWithPeriodKind,
  periodStart: string,
): Promise<DepositDetailRow> {
  const year = Number(periodStart.slice(0, 4));
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const firstMonth = (quarter - 1) * 3 + 1;
  const lastMonth = quarter * 3;
  const firstPeriod = periodStartFor(year, firstMonth);
  const lastPeriod = periodStartFor(year, lastMonth);

  const breakdownRows = await db
    .select({
      category: payrollEntries.category,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date >= ${firstPeriod}::date`,
        sql`date_trunc('month', ${payrollRuns.payDate})::date <= ${lastPeriod}::date`,
        eq(payrollEntries.category, "state_withholding"),
        sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
      ),
    )
    .groupBy(payrollEntries.category);

  const breakdown: DepositDetailRow["breakdown"] = [];
  const row = breakdownRows.find((r) => r.category === "state_withholding");
  breakdown.push({
    category: "state_withholding",
    amount: row ? row.amount : "0.00",
  });

  const runs = await db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      employeeName: employees.legalName,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollRuns)
    .innerJoin(payrollEntries, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date >= ${firstPeriod}::date`,
        sql`date_trunc('month', ${payrollRuns.payDate})::date <= ${lastPeriod}::date`,
        eq(payrollEntries.category, "state_withholding"),
        sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
      ),
    )
    .groupBy(payrollRuns.publicId, payrollRuns.payDate, employees.legalName)
    .orderBy(payrollRuns.payDate);

  return {
    deposit: { ...deposit, periodKind: "quarter" },
    breakdown,
    runs: runs.map((row) => ({
      publicId: row.publicId,
      payDate: row.payDate,
      employeeName: row.employeeName,
      amount: row.amount,
    })),
  };
}

/**
 * Fetch a deposit with its detail data for the admin view.
 * Returns null when no deposit with id exists.
 */
export async function getDepositDetail(db: Db, id: number): Promise<DepositDetailRow | null> {
  const depositRows = await db.select().from(taxDeposits).where(eq(taxDeposits.id, id)).limit(1);
  const deposit = depositRows[0];
  if (!deposit) return null;

  // Spec 23 §5: the kind is the stored column, never today's schedule. A
  // superseded row is still returned (audit).
  const withKind = withPeriodKind(deposit);
  if (withKind.periodKind === "quarter") {
    return getQuarterlyDepositDetail(db, withKind, deposit.periodStart);
  }
  return getFederalOrMonthlyDepositDetail(db, deposit, deposit.periodStart);
}
