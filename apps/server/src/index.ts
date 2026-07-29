/**
 * Payroll API server entrypoint.
 */

import { buildApp } from "./app.js";
import { databaseUrl } from "./config.js";
import { startScheduler } from "./payroll/scheduler.js";

// Scheduler is wired here (not in buildApp) so integration tests boot the app
// without pg-boss, which needs a real Postgres.
const schedulerEnabled =
  process.env.SCHEDULER_ENABLED !== "false" && process.env.NODE_ENV !== "test";

let onScheduleChange: (() => Promise<void>) | undefined;
const { app, config, db } = await buildApp({
  ...(schedulerEnabled
    ? {
        onScheduleChange: async () => {
          await onScheduleChange?.();
        },
      }
    : {}),
});

const start = async () => {
  try {
    if (config.nodeEnv !== "production" && config.sessionSecret.startsWith("dev-only")) {
      app.log.warn(
        "using dev fallback session secret — set SECRETS_DIR/session-secret in production",
      );
    }
    if (schedulerEnabled) {
      const scheduler = await startScheduler({ db, config, databaseUrl: databaseUrl(config) });
      onScheduleChange = scheduler.syncSchedules;
      app.addHook("onClose", async () => {
        await scheduler.stop();
      });
      app.log.info("pg-boss scheduler started");
    }
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
