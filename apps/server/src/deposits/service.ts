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
import { formatCents, formatMoney, parseCents } from "@payroll/shared";
import {
  EVENT_TYPE,
  taxDepositDue as tplTaxDepositDue,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import {
  dueDateFor,
  periodLabel,
  periodStartFor,
  quarterOfMonth,
  stateDueDateFor,
  statePeriodStartFor,
  type PeriodKind,
  type StateSchedule,
} from "./periods.js";
import {
  planStateQuarter,
  type DepositCredit,
  type LiveDepositRow,
  type QuarterPlan,
} from "./transition.js";

export {
  dueDateFor,
  periodLabel,
  periodStartFor,
  quarterOfMonth,
  stateDueDateFor,
  statePeriodStartFor,
  type PeriodKind,
  type StateSchedule,
};

export interface TaxDepositWithPeriodKind extends TaxDepositRow {
  periodKind: PeriodKind;
}

export type TaxDepositRow = typeof taxDeposits.$inferSelect;

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
interface DepositDetailBase {
  deposit: TaxDepositWithPeriodKind;
  breakdown: { category: string; amount: string }[];
  runs: { publicId: string; payDate: string; employeeName: string; amount: string }[];
}

/** A deposited row counted against this row's period (spec 23 §7). */
export interface DepositCreditRow {
  depositId: number;
  periodStart: string;
  periodKind: PeriodKind;
  depositedOn: string;
  /** The whole payment. */
  amount: string;
  /** The part of the payment counted toward THIS row (≤ amount). */
  applied: string;
}

/** PAY-36 detail + PAY-91 transition fields. All money as "0.00" strings. */
export interface DepositDetailRow extends DepositDetailBase {
  /** The unit's liability for this row's period (month or quarter). */
  liability: string;
  credits: DepositCreditRow[];
  /** Unit overpayment (D6); "0.00" normally. */
  overpaid: string;
  /** Superseded rows only: the live rows that replaced it. */
  replacedBy: { id: number; periodStart: string; periodKind: PeriodKind }[];
}

/** Live tax deposit row as listed (spec 23 §7: `overpaid` drives the list chip). */
export interface TaxDepositListRow extends TaxDepositWithPeriodKind {
  overpaid: string;
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** UTC-safe day arithmetic on ISO dates (no server-local timezone leakage). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The deposit amount for a month: the five deposit categories summed across
 * ISSUED runs with pay_date in the month. Draft/void/awaiting runs never
 * count. NUMERIC sum in SQL — exact decimal math, no floats, to the cent.
 */
export async function computeDepositAmount(
  db: Pick<Db, "select">,
  year: number,
  month: number,
): Promise<string> {
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

function toStateSchedule(row: typeof stateDepositSchedules.$inferSelect): StateSchedule {
  const frequency = row.frequency as "monthly" | "quarterly";
  return {
    frequency,
    dueDay: row.dueDay,
  };
}

/** Load all state deposit schedules into a Map keyed by "stateCode:taxYear". */
async function loadStateSchedules(db: Pick<Db, "select">): Promise<Map<string, StateSchedule>> {
  const rows = await db.select().from(stateDepositSchedules);
  const map = new Map<string, StateSchedule>();
  for (const row of rows) {
    const key = `${row.stateCode}:${row.taxYear}`;
    map.set(key, toStateSchedule(row));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deposit sync (daily tick) — federal upsert + state period planner (PAY-91)
// ---------------------------------------------------------------------------

export interface SyncResult {
  created: number;
  recomputed: number;
  flippedOverdue: number;
  /** PAY-91: rows replaced by a monthly <-> quarterly period transition. */
  superseded: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Federal (PAY-9): one month row per pay month; the amount of a PENDING row
 * is recomputed when a late run issues. Deposited/overdue rows are never
 * rewritten (spec 23 D4 keeps federal unchanged).
 */
async function syncFederalDeposit(db: Tx, periodStart: string, result: SyncResult) {
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

/** One (state, year, quarter) planning unit (spec 23 §6). */
interface StateUnit {
  state: string;
  year: number;
  quarter: number;
  liability: [number, number, number];
  live: LiveDepositRow[];
}

function unitKey(state: string, year: number, quarter: number): string {
  return `${state}:${year}:${quarter}`;
}

function toLiveRow(row: TaxDepositRow): LiveDepositRow {
  return {
    id: row.id,
    kind: withPeriodKind(row).periodKind,
    periodStart: row.periodStart,
    cents: parseCents(row.amount),
    status: row.status as LiveDepositRow["status"],
    dueDate: row.dueDate,
    depositedOn: row.depositedOn,
  };
}

/**
 * Issued-run state withholding in cents per (state, pay month). Year and
 * quarter come from the PAY DATE (R1); the work state from the frozen run
 * snapshot. Exact NUMERIC sums, parsed to cents.
 */
async function loadStateLiability(
  db: Pick<Db, "select">,
  filter?: { state: string; year: number; quarter: number },
): Promise<{ state: string; month: string; cents: number }[]> {
  const workState = sql<string>`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}')`;
  const month = sql<string>`to_char(date_trunc('month', ${payrollRuns.payDate})::date, 'YYYY-MM-DD')`;
  const conditions: SQLWrapper[] = [
    eq(payrollRuns.status, "issued"),
    eq(payrollEntries.category, "state_withholding"),
    sql`${workState} IS NOT NULL`,
  ];
  if (filter) {
    const first = periodStartFor(filter.year, (filter.quarter - 1) * 3 + 1);
    conditions.push(sql`${workState} = ${filter.state}`);
    conditions.push(sql`date_trunc('quarter', ${payrollRuns.payDate})::date = ${first}::date`);
  }
  const rows = await db
    .select({
      state: workState,
      month,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(and(...conditions))
    .groupBy(workState, month);
  return rows.map((r) => ({ state: r.state, month: r.month, cents: parseCents(r.amount) }));
}

function unitFor(units: Map<string, StateUnit>, state: string, periodStart: string): StateUnit {
  const year = Number(periodStart.slice(0, 4));
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const key = unitKey(state, year, quarter);
  let unit = units.get(key);
  if (!unit) {
    unit = { state, year, quarter, liability: [0, 0, 0], live: [] };
    units.set(key, unit);
  }
  return unit;
}

/** Units = DISTINCT (state, year, quarter) of issued state runs ∪ live state rows. */
async function loadStateUnits(
  db: Pick<Db, "select">,
  filter?: { state: string; year: number; quarter: number },
): Promise<StateUnit[]> {
  const units = new Map<string, StateUnit>();
  for (const l of await loadStateLiability(db, filter)) {
    const unit = unitFor(units, l.state, l.month);
    const m = (Number(l.month.slice(5, 7)) - 1) % 3;
    unit.liability[m] = (unit.liability[m] ?? 0) + l.cents;
  }
  const conditions: SQLWrapper[] = [sql`${taxDeposits.jurisdiction} <> 'federal'`, liveDeposit];
  if (filter) {
    const first = periodStartFor(filter.year, (filter.quarter - 1) * 3 + 1);
    conditions.push(eq(taxDeposits.jurisdiction, filter.state));
    conditions.push(sql`date_trunc('quarter', ${taxDeposits.periodStart})::date = ${first}::date`);
  }
  const rows = await db
    .select()
    .from(taxDeposits)
    .where(and(...conditions))
    .orderBy(taxDeposits.id);
  for (const row of rows) {
    unitFor(units, row.jurisdiction, row.periodStart).live.push(toLiveRow(row));
  }
  return [...units.values()].sort((a, b) =>
    unitKey(a.state, a.year, a.quarter) < unitKey(b.state, b.year, b.quarter) ? -1 : 1,
  );
}

function planUnit(
  unit: StateUnit,
  schedules: Map<string, StateSchedule>,
  today: string,
): QuarterPlan {
  return planStateQuarter({
    year: unit.year,
    quarter: unit.quarter,
    // Schedule by pay-date year (R1): the unit's year.
    schedule: schedules.get(`${unit.state}:${unit.year}`) ?? null,
    liability: unit.liability,
    live: unit.live,
    today,
  });
}

/** Apply one unit's plan: supersede, then update, then insert (the index needs that order). */
async function applyPlan(
  tx: Tx,
  unit: StateUnit,
  plan: QuarterPlan,
  result: SyncResult,
): Promise<void> {
  const now = new Date();
  const open = ["pending", "overdue"];
  const superseded = plan.supersede.length
    ? await tx
        .update(taxDeposits)
        .set({ status: "superseded", supersededAt: now, updatedAt: now })
        // Guard: a deposited row is never superseded.
        .where(and(inArray(taxDeposits.id, plan.supersede), inArray(taxDeposits.status, open)))
        .returning({ id: taxDeposits.id })
    : [];
  for (const u of plan.updates) {
    await tx
      .update(taxDeposits)
      .set({ amount: formatCents(u.cents), dueDate: u.dueDate, status: u.status, updatedAt: now })
      .where(and(eq(taxDeposits.id, u.id), inArray(taxDeposits.status, open)));
  }
  const inserted = plan.inserts.length
    ? await tx
        .insert(taxDeposits)
        .values(
          plan.inserts.map((i) => ({
            jurisdiction: unit.state,
            periodStart: i.periodStart,
            periodKind: i.kind,
            amount: formatCents(i.cents),
            dueDate: i.dueDate,
            status: i.status,
            createdBy: "scheduler",
          })),
        )
        .returning({ id: taxDeposits.id })
    : [];
  result.superseded += superseded.length;
  result.recomputed += plan.updates.length;
  result.created += inserted.length;

  if (superseded.length > 0) {
    const beforeRows = unit.live.filter((r) => plan.supersede.includes(r.id));
    await tx.insert(auditEvents).values({
      actorId: "scheduler",
      action: "tax_deposit.period_transition",
      entity: "tax_deposit",
      entityId: `${unit.state}:${unit.year}-Q${unit.quarter}`,
      before: { rows: beforeRows },
      after: {
        superseded: superseded.map((r) => r.id),
        updated: plan.updates,
        inserted: inserted.map((r, n) => ({ id: r.id, ...plan.inserts[n] })),
        liabilityCents: plan.liabilityCents,
        creditsCents: plan.depositedCents,
        overpaidCents: plan.overpaidCents,
      },
    });
  }
}

/** Serialises the deposit sync (daily tick, seed-qa, e2e serve) — spec 23 §6. */
const SYNC_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('tax_deposits_state_sync'))`;

/**
 * Upsert the computed deposit schedule for every pay month with issued
 * payroll history — INCLUDING the current month (PAY-14): the row appears as
 * soon as a run issues, because deposits are typically paid right after
 * payroll, weeks before the due date. Then flip past-due pending rows with
 * something to pay to 'overdue'.
 *
 * Federal rows: one per month (PAY-9), pending amounts recomputed.
 * State rows (PAY-47/48/91): one plan per (state, year, quarter) unit from
 * `planStateQuarter` — quarterly schedules merge into one quarter row,
 * monthly (or no schedule) keep month rows, and a schedule change supersedes
 * the replaced rows (kept for audit, never counted). Deposited rows are
 * never touched. The whole sync runs in one transaction under an advisory
 * lock; re-running it is a no-op (the planner writes only changed fields).
 */
export async function syncDeposits(deps: Deps, opts: { today?: string } = {}): Promise<SyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();
  const result: SyncResult = { created: 0, recomputed: 0, flippedOverdue: 0, superseded: 0 };

  await db.transaction(async (tx) => {
    // The federal loop shares the lock: two concurrent syncs would otherwise
    // both insert the same new federal month (select-then-insert).
    await tx.execute(SYNC_LOCK);
    const months = await tx
      .selectDistinct({
        periodStart: sql<string>`to_char(date_trunc('month', ${payrollRuns.payDate})::date, 'YYYY-MM-DD')`,
      })
      .from(payrollRuns)
      .where(eq(payrollRuns.status, "issued"))
      .orderBy(sql`1`);
    for (const { periodStart } of months) {
      await syncFederalDeposit(tx, periodStart, result);
    }

    const schedules = await loadStateSchedules(tx);
    for (const unit of await loadStateUnits(tx)) {
      await applyPlan(tx, unit, planUnit(unit, schedules, today), result);
    }

    const flipped = await tx
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
  });

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
): Promise<TaxDepositListRow[]> {
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
  const overpaid = rows.some((r) => r.jurisdiction !== "federal")
    ? await unitOverpayments(db)
    : new Map<string, number>();
  return rows.map((row) => {
    const unit = unitKey(
      row.jurisdiction,
      Number(row.periodStart.slice(0, 4)),
      quarterOfMonth(Number(row.periodStart.slice(5, 7))),
    );
    return { ...withPeriodKind(row), overpaid: formatCents(overpaid.get(unit) ?? 0) };
  });
}

/** Overpayment (D6) per state unit, from the planner run read-only. */
async function unitOverpayments(db: Db): Promise<Map<string, number>> {
  const schedules = await loadStateSchedules(db);
  const today = todayIso();
  const out = new Map<string, number>();
  for (const unit of await loadStateUnits(db)) {
    const cents = planUnit(unit, schedules, today).overpaidCents;
    if (cents > 0) out.set(unitKey(unit.state, unit.year, unit.quarter), cents);
  }
  return out;
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
): Promise<DepositDetailBase> {
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

  const breakdown: DepositDetailBase["breakdown"] = [];
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
): Promise<DepositDetailBase> {
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

  const breakdown: DepositDetailBase["breakdown"] = [];
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
  const base =
    withKind.periodKind === "quarter"
      ? await getQuarterlyDepositDetail(db, withKind, deposit.periodStart)
      : await getFederalOrMonthlyDepositDetail(db, deposit, deposit.periodStart);
  return { ...base, ...(await transitionDetail(db, withKind)) };
}

function toCreditRow(c: DepositCredit): DepositCreditRow {
  return {
    depositId: c.depositId,
    periodStart: c.periodStart,
    periodKind: c.periodKind,
    depositedOn: c.depositedOn ?? "",
    amount: formatCents(c.amountCents),
    applied: formatCents(c.appliedCents),
  };
}

/**
 * Spec 23 §7: liability, credits, overpayment and replacement for one row,
 * derived by the same pure planner the sync uses (read-only here), so the
 * sync and the API can never disagree.
 */
async function transitionDetail(
  db: Db,
  deposit: TaxDepositWithPeriodKind,
): Promise<Pick<DepositDetailRow, "liability" | "credits" | "overpaid" | "replacedBy">> {
  const year = Number(deposit.periodStart.slice(0, 4));
  const month = Number(deposit.periodStart.slice(5, 7));
  if (deposit.jurisdiction === "federal") {
    return {
      liability: await computeDepositAmount(db, year, month),
      credits: [],
      overpaid: "0.00",
      replacedBy: [],
    };
  }
  const quarter = quarterOfMonth(month);
  const filter = { state: deposit.jurisdiction, year, quarter };
  const unit = (await loadStateUnits(db, filter))[0] ?? {
    ...filter,
    liability: [0, 0, 0] as [number, number, number],
    live: [],
  };
  const plan = planUnit(unit, await loadStateSchedules(db), todayIso());
  const m = (month - 1) % 3;
  const isQuarter = deposit.periodKind === "quarter";
  const credits = (isQuarter ? plan.quarterCredits : (plan.monthCredits[m] ?? []))
    .filter((c) => c.depositId !== deposit.id)
    .map(toCreditRow);
  const replacedBy =
    deposit.status === "superseded"
      ? unit.live
          .filter((r) => r.kind !== deposit.periodKind)
          .map((r) => ({ id: r.id, periodStart: r.periodStart, periodKind: r.kind }))
      : [];
  return {
    liability: formatCents(isQuarter ? plan.liabilityCents : (unit.liability[m] ?? 0)),
    credits,
    overpaid: formatCents(plan.overpaidCents),
    replacedBy,
  };
}
