/**
 * Server configuration — env-driven, secrets read as FILES from SECRETS_DIR
 * (spec 8: secrets are never env values).
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
  /** Public base URL of the app (behind NPM proxy in prod). */
  baseUrl: string;
  /** TOTP issuer / app name shown in authenticator apps. */
  totpIssuer: string;
  /** Directory holding secret files: db-password, smtp-password, encryption-key, session-secret. */
  secretsDir: string;
  /** Resolved session secret (from $SECRETS_DIR/session-secret; dev fallback allowed). */
  sessionSecret: string;
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
export function readSecret(config: Pick<AppConfig, "secretsDir">, name: string): string | undefined {
  try {
    return readFileSync(join(config.secretsDir, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const secretsDir = env("SECRETS_DIR", "./secrets");
  const nodeEnv = env("NODE_ENV", "development");
  const base: AppConfig = {
    port: Number(env("PORT", "8989")),
    host: env("HOST", "0.0.0.0"),
    nodeEnv,
    logLevel: env("LOG_LEVEL", "info"),
    appTz: env("APP_TZ", "Europe/Madrid"),
    baseUrl: env("BASE_URL", `http://localhost:${Number(env("PORT", "8989"))}`),
    totpIssuer: env("TOTP_ISSUER", "Payroll"),
    secretsDir,
    // In production the session secret MUST come from the secrets dir; in dev
    // a fixed fallback keeps local iteration sane (logged loudly at boot).
    sessionSecret:
      readSecret({ secretsDir }, "session-secret") ??
      (nodeEnv === "production"
        ? (() => {
            throw new Error("session-secret missing from SECRETS_DIR in production");
          })()
        : "dev-only-insecure-session-secret"),
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
  return { ...base, ...overrides };
}

/** Assemble the postgres connection URL; password from the secrets dir (or dev default). */
export function databaseUrl(config: AppConfig, password?: string): string {
  const pw = password ?? readSecret(config, "db-password") ?? "payroll";
  return `postgres://${config.db.user}:${encodeURIComponent(pw)}@${config.db.host}:${config.db.port}/${config.db.name}`;
}

/** True when SMTP is configured enough to attempt sending (step 4 wires actual sending). */
export function smtpConfigured(config: AppConfig): boolean {
  return Boolean(config.smtp.host && config.smtp.from);
}
