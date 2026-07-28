/**
 * Payroll API server — step 1 skeleton.
 *
 * Fastify + pino structured JSON logs to stdout (spec 8 observability).
 * Only GET /health exists so far; auth, payroll, change-request and
 * notification routes land in steps 2–4 (see plan/README.md build order).
 */

import Fastify from "fastify";
import { loadConfig } from "./config.js";

const config = loadConfig();

const app = Fastify({
  logger: {
    level: config.logLevel,
    // Structured JSON to stdout in every environment — docker logs is the sink.
  },
});

app.get("/health", async () => ({ ok: true }));

const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
