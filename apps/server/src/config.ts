/**
 * Server configuration — env-driven, secrets read as FILES from SECRETS_DIR
 * (spec 8: secrets are never env values). No business config yet (step 1).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  logLevel: string;
  /** Display timezone for dates (DB stores TIMESTAMPTZ). */
  appTz: string;
  /** Directory holding secret files: db-password, smtp-password, encryption-key, session-secret. */
  secretsDir: string;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    from: string;
  };
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/** Read a secret from $SECRETS_DIR/<name>; returns undefined when absent (dev tolerance). */
export function readSecret(config: AppConfig, name: string): string | undefined {
  try {
    return readFileSync(join(config.secretsDir, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function loadConfig(): AppConfig {
  return {
    port: Number(env("PORT", "8989")),
    host: env("HOST", "0.0.0.0"),
    nodeEnv: env("NODE_ENV", "development"),
    logLevel: env("LOG_LEVEL", "info"),
    appTz: env("APP_TZ", "Europe/Madrid"),
    secretsDir: env("SECRETS_DIR", "./secrets"),
    db: {
      host: env("DB_HOST", "localhost"),
      port: Number(env("DB_PORT", "5432")),
      name: env("DB_NAME", "payroll"),
      user: env("DB_USER", "payroll"),
    },
    smtp: {
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT", "587")),
      user: env("SMTP_USER"),
      from: env("SMTP_FROM"),
    },
  };
}
