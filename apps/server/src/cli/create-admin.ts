/**
 * First-admin seeding CLI (spec 3): creates the initial admin user (invited,
 * pending enrollment) and prints the setup link. The same link is queued in
 * email_outbox; when SMTP is configured (step 4) it is also emailed.
 *
 * Usage:
 *   pnpm create-admin <email> [--name "Admin Name"]
 *   docker compose exec app pnpm create-admin <email>
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createAuth } from "../auth/auth.js";
import { inviteUser, UserServiceError } from "../auth/users.js";

const email = process.argv[2];
const nameFlag = process.argv.indexOf("--name");
const name = nameFlag !== -1 ? process.argv[nameFlag + 1] : undefined;

if (!email?.includes("@")) {
  console.error('usage: pnpm create-admin <email> [--name "Admin Name"]');
  process.exit(1);
}

const config = loadConfig();
const { db, dialect, close } = createDb(config);
const auth = createAuth({ config, db, dialect });

try {
  const result = await inviteUser(
    { auth, db, config },
    { name: name ?? "Administrator", email, role: "admin" },
    null,
  );
  console.log(`\nAdmin invited: ${result.email}`);
  console.log(`Setup link (single-use, valid 24h):\n\n  ${result.setupLink}\n`);
  if (result.smtpMissing) {
    console.log("SMTP is not configured — copy this link manually to the admin.");
  } else {
    console.log("The link was also queued in email_outbox for SMTP delivery.");
  }
  console.log("The account becomes active only after password + TOTP enrollment.");
} catch (err) {
  if (err instanceof UserServiceError && err.code === "email_exists") {
    console.error(`error: a user with email ${email} already exists`);
    process.exit(1);
  }
  throw err;
} finally {
  await close();
}
