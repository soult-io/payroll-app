/**
 * Payroll API server entrypoint.
 */

import { buildApp } from "./app.js";

const { app, config } = await buildApp();

const start = async () => {
  try {
    if (config.nodeEnv !== "production" && config.sessionSecret.startsWith("dev-only")) {
      app.log.warn("using dev fallback session secret — set SECRETS_DIR/session-secret in production");
    }
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
