/**
 * One-off CLI (pay-date amendment, 2026-07-29): correct legacy-imported
 * pay_date values to the 15th of the period month — column, snapshot, and
 * snapshot hash. See src/migrate/paydate-fix.ts.
 *
 * Usage:
 *   pnpm fix-legacy-paydates
 *   docker exec payroll-app node dist/cli/fix-legacy-paydates.js
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { fixLegacyPaydates } from "../migrate/paydate-fix.js";

const config = loadConfig();
const { db, close } = createDb(config, process.env.DATABASE_URL);

try {
  await fixLegacyPaydates(db, (line) => console.log(line));
} finally {
  await close();
}
