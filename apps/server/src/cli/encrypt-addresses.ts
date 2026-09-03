/**
 * One-off CLI (PAY-21): encrypt existing employee address data in place —
 * employees.address/mailing_address, the address history in
 * change_requests.payload, and the pre-change snapshots in audit_events.
 * Idempotent; safe to re-run. See src/migrate/address-encryption.ts.
 *
 * Usage:
 *   pnpm encrypt-addresses
 *   docker exec payroll-app node dist/cli/encrypt-addresses.js
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { encryptStoredAddresses } from "../migrate/address-encryption.js";

const config = loadConfig();
const { db, close } = createDb(config, process.env.DATABASE_URL);

try {
  const report = await encryptStoredAddresses({ db, config }, { log: (line) => console.log(line) });
  console.log(`report: ${JSON.stringify(report)}`);
} finally {
  await close();
}
