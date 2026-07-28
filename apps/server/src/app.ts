/**
 * Fastify app factory — everything except listen(), so tests can inject.
 */

import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { createDb, type Database } from "./db.js";
import { createAuth } from "./auth/auth.js";
import { mountBetterAuth } from "./auth/fastify-mount.js";
import { createGuards } from "./plugins/guards.js";
import { csrfOriginCheck } from "./plugins/csrf.js";
import { securityHeaders } from "./plugins/security-headers.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerAdminRoutes } from "./routes/admin-users.js";
import { registerAdminPayrollRoutes } from "./routes/admin-payroll.js";
import { registerPayslipRoutes } from "./routes/payslips.js";
import { registerChangeRequestRoutes } from "./routes/change-requests.js";
import { registerMyRoutes } from "./routes/my.js";
import { registerAdminNotificationRoutes } from "./routes/admin-notifications.js";
import { registerStubRoutes } from "./routes/stubs.js";

export interface BuildAppDeps {
  config?: AppConfig;
  /**
   * Test override: inject a database (e.g. PGlite-backed). Production uses
   * createDb() (postgres-js over TCP).
   */
  database?: Database;
  /** Re-register scheduler cron after pay-schedule edits (wired in index.ts). */
  onScheduleChange?: () => Promise<void>;
}

export async function buildApp(deps: BuildAppDeps = {}) {
  const config = deps.config ?? loadConfig();
  const database = deps.database ?? createDb(config);
  const { db, dialect } = database;
  const auth = createAuth({ config, db, dialect });
  const guards = createGuards({ auth, db });

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", csrfOriginCheck(config));
  app.addHook("onSend", securityHeaders);

  app.get("/health", async () => ({ ok: true }));

  mountBetterAuth(app, { auth, config });
  registerOnboardingRoutes(app, { auth, db, config, guards });
  registerAdminRoutes(app, { auth, db, config, guards });
  registerAdminPayrollRoutes(app, {
    db,
    config,
    guards,
    ...(deps.onScheduleChange ? { onScheduleChange: deps.onScheduleChange } : {}),
  });
  registerPayslipRoutes(app, { db, guards });
  registerChangeRequestRoutes(app, { db, config, guards });
  registerMyRoutes(app, { db, config, guards });
  registerAdminNotificationRoutes(app, { db, config, guards });
  registerStubRoutes(app, guards);

  // Serve the built SPA when present (spec 8: server serves the SPA).
  const publicDir = process.env.PUBLIC_DIR
    ? resolve(process.env.PUBLIC_DIR)
    : [resolve(process.cwd(), "public"), resolve(process.cwd(), "../web/dist")].find((p) =>
        existsSync(p),
      );
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: true });
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && publicDir) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return { app, auth, db, database, config };
}

export type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
export type { FastifyInstance };
