/**
 * Legacy migration CLI (spec 9): copies payroll history from
 * `second_brain.accounting` (mcp-accounting) into the payroll database.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgres://… pnpm migrate:legacy [--dry-run] [--write] [--verbose]
 *
 *   --dry-run (default)  full analysis + snapshot validation, ZERO writes
 *   --write              perform the migration (idempotent — re-run is a no-op)
 *   --verbose            per-run detail lines
 *
 * Target database: DATABASE_URL if set, otherwise the standard app config
 * (DB_HOST/DB_PORT/DB_NAME/DB_USER + $SECRETS_DIR/db-password) — same as the
 * server itself. Source is ALWAYS SOURCE_DATABASE_URL, e.g.
 *   postgres://pai:<pw>@second-brain-db:5432/second_brain
 *
 * Exit codes: 0 success · 2 validation failure (nothing written) · 1 other error.
 */

import postgres from "postgres";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import {
  LEGACY_ENGINE_VERSION,
  migrateLegacy,
  MigrationHaltError,
  MigrationValidationError,
} from "./migrate.js";
import type { SourceDb } from "./source.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const dryRun = args.includes("--dry-run") || !write; // default: dry-run
const verbose = args.includes("--verbose");

const sourceUrl = process.env.SOURCE_DATABASE_URL;
if (!sourceUrl) {
  console.error(
    "error: SOURCE_DATABASE_URL is required (the second_brain postgres connection string)",
  );
  process.exit(1);
}
if (!dryRun && !write) {
  console.error("error: pass exactly one of --dry-run / --write");
  process.exit(1);
}

const sourceSql = postgres(sourceUrl, { max: 2 });
const source: SourceDb = {
  query: async <T>(text: string, params?: unknown[]): Promise<T[]> => {
    const rows = await sourceSql.unsafe(text, (params ?? []) as never[]);
    return rows as unknown as T[];
  },
  close: () => sourceSql.end(),
};

const config = loadConfig();
const database = createDb(config, process.env.DATABASE_URL);
const log = (line: string) => console.log(line);

console.log(`mode: ${dryRun ? "DRY-RUN (analysis only, zero writes)" : "WRITE"}`);
console.log(
  `snapshots: engineVersion='${LEGACY_ENGINE_VERSION}', validated to the cent before any write`,
);

try {
  const report = await migrateLegacy({ source, db: database.db }, { dryRun, verbose, log });
  console.log(
    `\nsummary: ${report.runsValidated} run(s) validated; ` +
      report.entities.map((e) => `${e.entity} +${e.inserted}/=${e.existing}`).join(", "),
  );
  if (dryRun) console.log("dry-run only — re-run with --write to perform the migration.");
} catch (err) {
  if (err instanceof MigrationValidationError) {
    console.error(`\nVALIDATION FAILED — nothing was written. ${err.message}\n`);
    for (const f of err.failures) {
      console.error(
        `  run ${f.sourceRunId} (${f.year}-${String(f.month).padStart(2, "0")}) ${f.category}: ` +
          `stored ${f.stored} ≠ recomputed ${f.recomputed}`,
      );
    }
    console.error(`\nInvestigate the source rows manually before migrating.`);
    process.exit(2);
  }
  if (err instanceof MigrationHaltError) {
    console.error(`\nHALTED — nothing was written: ${err.message}`);
    process.exit(2);
  }
  throw err;
} finally {
  await database.close();
  await source.close();
}
