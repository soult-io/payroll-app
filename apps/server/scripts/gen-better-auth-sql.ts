/**
 * Generate the Better Auth table SQL (user, session, account, verification,
 * twoFactor) using Better Auth's own migration compiler — the same engine the
 * @better-auth/cli `migrate` command uses — against an empty PGlite database.
 * Output is reviewed and merged into packages/db/drizzle migrations (spec 3:
 * auth-owned tables managed by Better Auth migrations).
 *
 * Run: pnpm tsx scripts/gen-better-auth-sql.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely";
import { getMigrations } from "better-auth/db/migration";
import { loadConfig } from "../src/config.js";
import { buildAuthOptions } from "../src/auth/auth.js";

const pglite = new PGlite("memory://");
const config = loadConfig();

const options = buildAuthOptions({
  config,
  // The audit hook / backup-codes plugin only touch db at request time;
  // schema generation never invokes them.
  db: null as never,
  dialect: new PGliteDialect({ pglite } as never),
});

const { compileMigrations } = await getMigrations(options);
const sql = await compileMigrations();
console.log(sql);
await pglite.close();
