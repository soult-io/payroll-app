/**
 * Database wiring — postgres-js driver + drizzle (spec 1/8).
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PostgresJSDialect } from "kysely-postgres-js";
import type { Dialect } from "kysely";
import * as schema from "@payroll/db";
import { databaseUrl, type AppConfig } from "./config.js";

export type Db = PostgresJsDatabase<typeof schema>;

/** Everything the app needs from its database connection. */
export interface Database {
  db: Db;
  dialect: Dialect;
  close: () => Promise<void>;
}

export function createDb(config: AppConfig, url?: string): Database {
  const sql = postgres(url ?? databaseUrl(config), {
    // Small pool: single admin + single employee workload; pg-boss arrives in step 3.
    max: 10,
  });
  return {
    db: drizzle(sql, { schema }),
    dialect: new PostgresJSDialect({ postgres: sql }),
    close: () => sql.end(),
  };
}

/**
 * True when an error is (or wraps) a Postgres unique-violation (23505).
 * Drizzle wraps driver errors in DrizzleQueryError with the original on
 * `cause` — walk the chain so both postgres-js and PGlite shapes match.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && (current as { code: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
