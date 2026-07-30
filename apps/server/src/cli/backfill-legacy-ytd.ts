/**
 * One-off CLI (template 1.1.0, 2026-07-30): backfill the `ytd` block into
 * legacy-imported run snapshots — derived from each run's own stored entries,
 * chronological accumulation, hash + audit trail. See src/migrate/ytd-backfill.ts.
 *
 * Usage:
 *   pnpm backfill-legacy-ytd
 *   docker exec payroll-app node dist/cli/backfill-legacy-ytd.js
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { backfillLegacyYtd } from "../migrate/ytd-backfill.js";

const config = loadConfig();
const { db, close } = createDb(config, process.env.DATABASE_URL);

try {
  await backfillLegacyYtd(db, (line) => console.log(line));
} finally {
  await close();
}
