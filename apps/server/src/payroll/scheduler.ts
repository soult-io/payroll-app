/**
 * Scheduler (spec payroll-engine D6): pg-boss against the app DB.
 *
 * - A monthly cron (from the company-wide pay_schedules row, draft day,
 *   default 15th) enqueues one job per auto-draft employee per period with
 *   singletonKey = "<employeeId>:<periodStart>" so retries can never
 *   double-generate (the DB UNIQUE(employee_id, period_start) is the second
 *   belt).
 * - Cron re-registers on boot and on pay-schedule change (syncSchedules).
 * - The email outbox drain worker is STUBBED here (drain-pattern shape only);
 *   actual SMTP sending lands in step 4.
 *
 * This module only wires pg-boss; all business logic lives in runs.ts and is
 * integration-tested without pg-boss (which needs a real Postgres).
 */

import { PgBoss } from "pg-boss";
import { eq, isNull } from "drizzle-orm";
import { emailOutbox, employees, paySchedules } from "@payroll/db";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { generateDraftsForPeriod, monthlyPeriod } from "./runs.js";

const TICK_QUEUE = "payroll-draft-tick";
const GENERATE_QUEUE = "payroll-generate-draft";
const OUTBOX_QUEUE = "email-outbox-drain";

export interface Scheduler {
  boss: PgBoss;
  /** Re-read pay_schedules and re-register the cron (call after edits). */
  syncSchedules: () => Promise<void>;
  stop: () => Promise<void>;
}

function currentPeriod(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export async function startScheduler(deps: {
  db: Db;
  config: AppConfig;
  databaseUrl: string;
}): Promise<Scheduler> {
  const { db, config } = deps;
  const boss = new PgBoss({
    connectionString: deps.databaseUrl,
    // Keep pg-boss's own schema out of the app's migration-managed schema.
    schema: "pgboss",
  });
  await boss.start();
  await boss.createQueue(TICK_QUEUE);
  await boss.createQueue(GENERATE_QUEUE);
  await boss.createQueue(OUTBOX_QUEUE);

  // Cron tick → enqueue per-employee generation jobs (singleton per period).
  await boss.work(TICK_QUEUE, async () => {
    const schedules = await db
      .select()
      .from(paySchedules)
      .where(isNull(paySchedules.employeeId));
    const schedule = schedules[0];
    if (!schedule || !schedule.active || !schedule.autoDraft) return;
    const { year, month } = currentPeriod();
    const period = monthlyPeriod(year, month, schedule.payDayOfMonth);

    const activeEmployees = await db
      .select({ id: employees.id })
      .from(employees);
    for (const employee of activeEmployees) {
      await boss.send(
        GENERATE_QUEUE,
        { employeeId: employee.id, year, month },
        { singletonKey: `${employee.id}:${period.periodStart}` },
      );
    }
  });

  // Per-employee generation — idempotent at the DB level as well.
  await boss.work<{ employeeId: number; year: number; month: number }>(
    GENERATE_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        await generateDraftsForPeriod(
          { db },
          {
            year: job.data.year,
            month: job.data.month,
            employeeId: job.data.employeeId,
            autoDraftOnly: true,
            createdBy: "scheduler",
          },
        );
      }
    },
  );

  // Outbox drain — STUB (step 4 wires SMTP). Establishes the drain pattern:
  // a repeating job that inspects pending rows; sending replaces the count.
  await boss.work(OUTBOX_QUEUE, async () => {
    const pending = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "pending"));
    if (pending.length > 0) {
      console.log(`[outbox-stub] ${pending.length} pending email(s) — SMTP sending arrives in step 4`);
    }
  });

  async function syncSchedules(): Promise<void> {
    const schedules = await db
      .select()
      .from(paySchedules)
      .where(isNull(paySchedules.employeeId));
    const schedule = schedules[0];
    await boss.unschedule(TICK_QUEUE);
    await boss.unschedule(OUTBOX_QUEUE);
    if (schedule?.active) {
      // Draft day at 09:12 local (off-peak minute), display timezone per spec 1.
      await boss.schedule(TICK_QUEUE, `12 9 ${schedule.draftDayOfMonth} * *`, null, {
        tz: config.appTz,
      });
    }
    // Outbox drain every minute (stub worker above; step 4 implements sending).
    await boss.schedule(OUTBOX_QUEUE, "47 * * * *", null, { tz: config.appTz });
  }

  await syncSchedules();

  return {
    boss,
    syncSchedules,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
