/**
 * Payroll run lifecycle (spec payroll-engine D6): draft generation with
 * temporal config resolution + idempotency, and the state machine
 * draft→awaiting_approval→approved→issued (void pre-issued only).
 * Every mutation writes audit_events in the same transaction.
 */

import { and, eq, isNull, ne, or } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  company,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  paySchedules,
} from "@payroll/db";
import {
  calculatePayroll,
  ENGINE_VERSION,
  PERIODS_PER_YEAR,
  type PayFrequency,
  type TaxConfig,
} from "@payroll/engine";
import { round2 } from "@payroll/engine/money";
import {
  EVENT_TYPE,
  payrollDraftReady as tplPayrollDraftReady,
  payslipIssued as tplPayslipIssued,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import { isUniqueViolation } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  resolveCompensation,
  resolvePriorYtdByCategory,
  resolvePriorYtdGross,
  resolveTaxConfig,
  resolveW4,
  toSnapshotW4,
  type DbLike,
} from "./resolve.js";
import { SNAPSHOT_TEMPLATE_VERSION, snapshotHash, type RunSnapshot } from "./snapshot.js";

export class PayrollServiceError extends Error {
  constructor(
    public code:
      | "no_compensation"
      | "no_tax_config"
      | "run_not_found"
      | "invalid_transition"
      | "void_reason_required"
      | "unsupported_frequency"
      | "no_company",
    message: string,
  ) {
    super(message);
  }
}

export interface Period {
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

/** Monthly schedule → period = calendar month; pay_date = pay_day_of_month. */
export function monthlyPeriod(year: number, month: number, payDayOfMonth: number): Period {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
    payDate: `${year}-${mm}-${String(payDayOfMonth).padStart(2, "0")}`,
  };
}

export type RunRow = typeof payrollRuns.$inferSelect;

interface GenerateDeps {
  db: Db;
  config: AppConfig;
}

async function templateCtx(
  tx: DbLike,
  config: AppConfig,
  fallbackCompanyName?: string,
): Promise<TemplateContext> {
  let companyName = fallbackCompanyName;
  if (!companyName) {
    const rows = await tx.select({ legalName: company.legalName }).from(company).limit(1);
    companyName = rows[0]?.legalName ?? "Payroll";
  }
  return { companyName, appUrl: config.baseUrl };
}

async function notifyDraftReady(
  tx: DbLike & Pick<Db, "insert">,
  ctx: TemplateContext,
  run: RunRow,
  employeeName: string,
): Promise<void> {
  const rendered = tplPayrollDraftReady(ctx, {
    employeeName,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDate: run.payDate,
  });
  const admins = await tx
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  for (const admin of admins) {
    await tx.insert(emailOutbox).values({
      userId: admin.id,
      eventType: EVENT_TYPE.payrollDraftReady,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
  }
}

/**
 * Generate one draft run (status='awaiting_approval') for an employee and
 * period, resolving all config as-of the period inside the transaction.
 * Idempotent: UNIQUE(employee_id, period_start) — a repeat returns the
 * existing run with created=false.
 */
export async function generateDraft(
  deps: GenerateDeps,
  input: { employeeId: number; period: Period; createdBy: string },
): Promise<{ run: RunRow; created: boolean }> {
  const { db } = deps;
  const { period } = input;

  const existing = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.employeeId, input.employeeId),
        eq(payrollRuns.periodStart, period.periodStart),
        // Void runs release the (employee, period) slot — regenerating after a
        // void creates a NEW run row (spec payroll-engine).
        ne(payrollRuns.status, "void"),
      ),
    )
    .limit(1);
  if (existing[0]) return { run: existing[0], created: false };

  try {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: draft-generation transaction; guard chain is the spec's resolution order
    return await db.transaction(async (tx) => {
      const employeeRows = await tx
        .select()
        .from(employees)
        .where(eq(employees.id, input.employeeId))
        .limit(1);
      const employee = employeeRows[0];
      if (!employee)
        throw new PayrollServiceError("run_not_found", `employee ${input.employeeId} not found`);
      const companyRows = await tx.select().from(company).limit(1);
      const companyRow = companyRows[0];
      if (!companyRow)
        throw new PayrollServiceError("no_company", "company row missing — run seeds");

      const comp = await resolveCompensation(tx, input.employeeId, period.periodStart);
      if (!comp) {
        throw new PayrollServiceError(
          "no_compensation",
          `no compensation effective on ${period.periodStart} for employee ${input.employeeId}`,
        );
      }
      const frequency = comp.frequency as PayFrequency;
      const periodsPerYear = PERIODS_PER_YEAR[frequency];
      if (!periodsPerYear) {
        throw new PayrollServiceError(
          "unsupported_frequency",
          `frequency ${comp.frequency} not supported`,
        );
      }

      const w4Row = await resolveW4(tx, input.employeeId, period.periodStart);
      const filingStatus = w4Row?.filingStatus ?? "single";
      const taxYear = Number(period.periodStart.slice(0, 4));
      const tax = await resolveTaxConfig(tx, taxYear, filingStatus);
      if (!tax) {
        throw new PayrollServiceError(
          "no_tax_config",
          `no federal tax config/brackets for ${taxYear}`,
        );
      }
      const priorYtdGross = await resolvePriorYtdGross(tx, input.employeeId, period.periodStart);
      const priorYtd = await resolvePriorYtdByCategory(tx, input.employeeId, period.periodStart);

      const engineConfig: TaxConfig = {
        year: tax.config.taxYear,
        standardDeduction: tax.config.standardDeduction,
        federalBrackets: tax.brackets.map((b) => ({
          min: b.min,
          max: b.max ?? Infinity,
          rate: b.rate,
        })),
        socialSecurityRate: tax.config.socialSecurityRate,
        socialSecurityWageCap: tax.config.socialSecurityWageCap,
        medicareRate: tax.config.medicareRate,
        medicareAdditionalRate: tax.config.medicareAdditionalRate,
        medicareAdditionalThreshold: tax.config.medicareAdditionalThreshold,
        stateWithholdingRate: tax.config.stateWithholdingRate,
        employerSocialSecurityRate: tax.config.employerSocialSecurityRate,
        employerMedicareRate: tax.config.employerMedicareRate,
        futaRate: tax.config.futaRate,
        futaWageCap: tax.config.futaWageCap,
      };

      const periodAmount = Number(comp.periodAmount);
      const result = calculatePayroll({
        monthlySalary: periodAmount,
        periodsPerYear: periodsPerYear as 12 | 24 | 26 | 52,
        priorYtdGross,
        taxConfig: engineConfig,
        federalExempt: w4Row?.federalExempt ?? false,
        w4: {
          dependentsAmount: w4Row ? Number(w4Row.dependentsAmount) : 0,
          otherIncome: w4Row ? Number(w4Row.otherIncome) : 0,
          deductionsAmount: w4Row ? Number(w4Row.deductionsAmount) : 0,
          extraWithholding: w4Row ? Number(w4Row.extraWithholding) : 0,
        },
      });

      const snapshot: RunSnapshot = {
        inputs: {
          periodAmount,
          frequency,
          periodsPerYear,
          w4: w4Row ? toSnapshotW4(w4Row) : null,
          taxConfig: tax.config,
          brackets: tax.brackets,
          priorYtdGross,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          payDate: period.payDate,
          company: { legalName: companyRow.legalName },
          employee: { legalName: employee.legalName, preferredName: employee.preferredName },
        },
        result,
        engineVersion: ENGINE_VERSION,
        templateVersion: SNAPSHOT_TEMPLATE_VERSION,
        ytd: {
          gross: round2((priorYtd.get("gross_pay") ?? 0) + result.grossPay),
          federalWithholding: round2(
            (priorYtd.get("federal_withholding") ?? 0) + result.federalWithholding,
          ),
          socialSecurity: round2((priorYtd.get("social_security") ?? 0) + result.socialSecurity),
          medicare: round2((priorYtd.get("medicare") ?? 0) + result.medicare),
          stateWithholding: round2(
            (priorYtd.get("state_withholding") ?? 0) + result.stateWithholding,
          ),
          totalDeductions: round2(
            (priorYtd.get("gross_pay") ?? 0) -
              (priorYtd.get("net_pay") ?? 0) +
              result.totalDeductions,
          ),
          netPay: round2((priorYtd.get("net_pay") ?? 0) + result.netPay),
        },
      };

      const inserted = await tx
        .insert(payrollRuns)
        .values({
          employeeId: input.employeeId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          payDate: period.payDate,
          status: "awaiting_approval",
          runSnapshot: snapshot,
          snapshotHash: snapshotHash(snapshot),
          createdBy: input.createdBy,
        })
        .returning();
      const run = inserted[0]!;

      const entryValues = [
        ["gross_pay", result.grossPay],
        ["federal_withholding", result.federalWithholding],
        ["social_security", result.socialSecurity],
        ["medicare", result.medicare],
        ["state_withholding", result.stateWithholding],
        ["net_pay", result.netPay],
        ["employer_social_security", result.employerSocialSecurity],
        ["employer_medicare", result.employerMedicare],
        ["employer_futa", result.employerFUTA],
      ] as const;
      await tx.insert(payrollEntries).values(
        entryValues.map(([category, amount]) => ({
          runId: run.id,
          category,
          amount: String(amount),
        })),
      );

      const tplCtx = await templateCtx(tx, deps.config, companyRow.legalName);
      await notifyDraftReady(tx as DbLike & Pick<Db, "insert">, tplCtx, run, employee.legalName);
      return { run, created: true };
    });
  } catch (err) {
    // Unique race (scheduler retry / double click): someone else created it.
    if (isUniqueViolation(err)) {
      const rows = await db
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.employeeId, input.employeeId),
            eq(payrollRuns.periodStart, period.periodStart),
            ne(payrollRuns.status, "void"),
          ),
        )
        .limit(1);
      if (rows[0]) return { run: rows[0], created: false };
    }
    throw err;
  }
}

/** Resolve the schedule row for an employee (per-employee overrides company default). */
export async function resolveSchedule(
  db: DbLike,
  employeeId: number,
): Promise<typeof paySchedules.$inferSelect | null> {
  const rows = await db
    .select()
    .from(paySchedules)
    .where(
      and(
        eq(paySchedules.active, true),
        or(eq(paySchedules.employeeId, employeeId), isNull(paySchedules.employeeId)),
      ),
    );
  const perEmployee = rows.find((r) => r.employeeId === employeeId);
  return perEmployee ?? rows.find((r) => r.employeeId === null) ?? null;
}

/**
 * Generate drafts for a period across employees. Scheduler path passes
 * autoDraftOnly=true (skips employees whose schedule disabled auto-draft);
 * the manual "generate draft now" endpoint passes false (off-cycle allowed).
 */
export async function generateDraftsForPeriod(
  deps: GenerateDeps,
  input: {
    year: number;
    month: number;
    employeeId?: number;
    autoDraftOnly: boolean;
    createdBy: string;
  },
): Promise<{ generated: RunRow[]; skipped: { employeeId: number; reason: string }[] }> {
  const { db } = deps;
  const employeeRows = input.employeeId
    ? await db.select().from(employees).where(eq(employees.id, input.employeeId))
    : await db.select().from(employees).where(eq(employees.status, "active"));

  const generated: RunRow[] = [];
  const skipped: { employeeId: number; reason: string }[] = [];
  for (const employee of employeeRows) {
    const schedule = await resolveSchedule(db, employee.id);
    if (!schedule) {
      skipped.push({ employeeId: employee.id, reason: "no_schedule" });
      continue;
    }
    if (input.autoDraftOnly && !schedule.autoDraft) {
      skipped.push({ employeeId: employee.id, reason: "auto_draft_off" });
      continue;
    }
    if (schedule.frequency !== "monthly") {
      skipped.push({ employeeId: employee.id, reason: "unsupported_frequency" });
      continue;
    }
    const period = monthlyPeriod(input.year, input.month, schedule.payDayOfMonth);
    try {
      const { run } = await generateDraft(deps, {
        employeeId: employee.id,
        period,
        createdBy: input.createdBy,
      });
      generated.push(run);
    } catch (err) {
      if (err instanceof PayrollServiceError) {
        skipped.push({ employeeId: employee.id, reason: err.code });
        continue;
      }
      throw err;
    }
  }
  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ["draft", "awaiting_approval"], to: "approved" },
  issue: { from: ["approved"], to: "issued" },
  // Spec: void pre-issued only. (The DB immutability trigger additionally
  // permits issued→void bookkeeping; the app is stricter per spec.)
  void: { from: ["draft", "awaiting_approval", "approved"], to: "void" },
};

export type RunAction = keyof typeof TRANSITIONS;

async function notifyPayslipIssued(
  tx: DbLike & Pick<Db, "insert">,
  ctx: TemplateContext,
  run: RunRow,
): Promise<void> {
  const rows = await tx.select().from(employees).where(eq(employees.id, run.employeeId)).limit(1);
  const employee = rows[0];
  if (!employee?.userId) return;
  // Spec: period + "log in to view/download" — no net pay, no attachment.
  const rendered = tplPayslipIssued(ctx, {
    periodLabel: `${run.periodStart} → ${run.periodEnd}`,
    payDate: run.payDate,
  });
  await tx.insert(emailOutbox).values({
    userId: employee.userId,
    eventType: EVENT_TYPE.payslipIssued,
    subject: rendered.subject,
    bodyHtml: rendered.html,
  });
}

/**
 * Apply a state-machine transition with audit_events in the same transaction.
 * Issue inserts the payslip_issued outbox row (spec 6 wiring is step 4).
 */
export async function transitionRun(
  deps: GenerateDeps,
  input: { publicId: string; action: RunAction; actorId: string; reason?: string },
): Promise<RunRow> {
  const { db } = deps;
  const rule = TRANSITIONS[input.action];
  if (!rule) throw new PayrollServiceError("invalid_transition", `unknown action ${input.action}`);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: state-machine transition transaction; kept linear with audit in the same tx
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.publicId, input.publicId))
      .limit(1);
    const run = rows[0];
    if (!run) throw new PayrollServiceError("run_not_found", `run ${input.publicId} not found`);
    if (!rule.from.includes(run.status)) {
      throw new PayrollServiceError(
        "invalid_transition",
        `cannot ${input.action} a run in status '${run.status}'`,
      );
    }
    if (input.action === "void" && !input.reason?.trim()) {
      throw new PayrollServiceError("void_reason_required", "voiding a run requires a reason");
    }

    const now = new Date();
    const patch =
      input.action === "approve"
        ? { status: "approved", approvedBy: input.actorId, approvedAt: now, updatedAt: now }
        : input.action === "issue"
          ? { status: "issued", issuedAt: now, updatedAt: now }
          : { status: "void", voidedAt: now, voidReason: input.reason!.trim(), updatedAt: now };

    const updated = await tx
      .update(payrollRuns)
      .set(patch)
      .where(eq(payrollRuns.id, run.id))
      .returning();
    const next = updated[0]!;

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      action: `run.${input.action}`,
      entity: "payroll_run",
      entityId: run.publicId,
      before: { status: run.status },
      after: { status: next.status, ...(input.reason ? { reason: input.reason } : {}) },
    });

    if (input.action === "issue") {
      const tplCtx = await templateCtx(tx as DbLike, deps.config);
      await notifyPayslipIssued(tx as DbLike & Pick<Db, "insert">, tplCtx, next);
    }
    return next;
  });
}

export async function getRunByPublicId(db: DbLike, publicId: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.publicId, publicId))
    .limit(1);
  return rows[0] ?? null;
}
