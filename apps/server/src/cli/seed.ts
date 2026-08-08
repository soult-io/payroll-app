/**
 * Seed CLI (spec 1: company row, 2025+2026 tax tables, default pay schedule).
 * Idempotent — safe to run on every deploy.
 *
 * Usage: pnpm seed
 */

import { SEED_COMPANY_NAME, seedDatabase } from "@payroll/db";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";

const config = loadConfig();
const { db, close } = createDb(config);

try {
  await seedDatabase(db);
  console.log(
    `Seed complete: company (${SEED_COMPANY_NAME}), tax_config/brackets 2025+2026, default pay schedule.`,
  );
} finally {
  await close();
}
