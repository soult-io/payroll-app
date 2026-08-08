/**
 * Contractor recurring-invoice scheduler (spec 12 §2 — the separate-scheduler
 * amendment, owner direction 2026-08-03: "like the W-2 scheduler, but
 * different, since this is for contractors").
 *
 * Same infrastructure and pattern as apps/server/src/payroll/scheduler.ts —
 * pg-boss against the app DB — but its OWN module, pg-boss instance, queue,
 * cron registration, and tick, so it can be inspected, logged, and disabled
 * (RECURRING_SCHEDULER_ENABLED=false) without touching payroll generation.
 *
 * The daily tick does two things (both idempotent, both unit-tested without
 * pg-boss via the service layer):
 *   1. generateRecurringInvoices — one 'submitted' invoice per due template
 *      (unique index + last_generated_period make re-runs no-ops);
 *   2. paymentDueSweep — on a template's pay_day_of_month of the following
 *      month, notify admins when the generated invoice is approved-but-unpaid
 *      (outbox markers suppress repeats, same pattern as the W-8 sweep).
 */

import { PgBoss } from "pg-boss";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { generateRecurringInvoices, paymentDueSweep } from "./recurring.js";

const TICK_QUEUE = "contractor-recurring-tick";

export interface RecurringScheduler {
  boss: PgBoss;
  stop: () => Promise<void>;
}

export async function startRecurringInvoiceScheduler(deps: {
  db: Db;
  config: AppConfig;
  databaseUrl: string;
}): Promise<RecurringScheduler> {
  const { db, config } = deps;
  const boss = new PgBoss({
    connectionString: deps.databaseUrl,
    // Keep pg-boss's own schema out of the app's migration-managed schema.
    schema: "pgboss",
  });
  await boss.start();
  await boss.createQueue(TICK_QUEUE);

  await boss.work(TICK_QUEUE, async () => {
    const generated = await generateRecurringInvoices({ db, config });
    if (generated.generated + generated.retired > 0) {
      console.log(`[contractor-recurring] generation tick: ${JSON.stringify(generated)}`);
    }
    const due = await paymentDueSweep({ db, config });
    if (due.due > 0) {
      console.log(`[contractor-recurring] payment-due sweep: ${JSON.stringify(due)}`);
    }
  });

  // Daily at 07:19 local (off-peak minute), display timezone per spec 1.
  await boss.schedule(TICK_QUEUE, "19 7 * * *", null, { tz: config.appTz });

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
