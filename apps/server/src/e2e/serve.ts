/**
 * E2E boot entry (hardening B): boots the REAL Fastify app against an
 * in-memory PGlite — the same wiring as the vitest integration harness
 * (test/helpers.ts) — then listens on 127.0.0.1:9898 so Playwright can drive
 * the built SPA against it. Migrations + seeds run at boot, two users are
 * created (admin fully onboarded; employee invited, onboarded by the browser
 * spec), a draft payroll run is generated, and the fixture state (TOTP
 * secret, invite link, run id) is written to e2e/.state/state.json.
 *
 * Production boot (src/index.ts) is untouched: postgres-js over TCP + the
 * pg-boss scheduler. This entry exists for browser E2E only and is never
 * imported by the production start path.
 */

import { PGlite } from "@electric-sql/pglite";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import { PGliteDialect } from "kysely";
import { eq } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import * as schema from "@payroll/db";
import {
  authTwoFactor,
  company,
  compensation,
  employees,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import type { Db } from "../db.js";
import { inviteUser } from "../auth/users.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const DRIZZLE_DIR = resolve(REPO_ROOT, "packages/db/drizzle");
const STATE_FILE = resolve(REPO_ROOT, "e2e/.state/state.json");

const HOST = "127.0.0.1";
const PORT = 9898;
const BASE_URL = `http://${HOST}:${PORT}`;
const ORIGIN = { origin: BASE_URL };

const ADMIN = { name: "E2E Admin", email: "e2e-admin@example.com" };
const ADMIN_PASSWORD = "correct-horse-battery-staple-9";
const EMPLOYEE = { name: "E2E Employee", email: "e2e-employee@example.com" };

interface Journal {
  entries: { idx: number; tag: string }[];
}

/**
 * Run all migrations in journal order against PGlite.
 * Verbatim from test/helpers.ts — duplicated deliberately so src/ never
 * imports from test/ (build boundary).
 */
async function runMigrations(pglite: PGlite): Promise<void> {
  const journal = JSON.parse(
    readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
  for (const entry of journal.entries) {
    const file = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
    const sql = readFileSync(file, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const stmt = statement.trim();
      if (!stmt) continue;
      try {
        await pglite.exec(stmt);
      } catch (err) {
        // PGlite may lack a contrib extension (e.g. btree_gist); skip only the
        // 0001 raw-SQL statements that depend on it, fail loudly otherwise.
        if (entry.tag.startsWith("0001")) continue;
        throw err;
      }
    }
  }
}

/** Extract a named cookie value from a set-cookie array (from flow-helpers). */
function cookieValue(setCookies: string | string[] | undefined, name: string): string | null {
  if (!setCookies) return null;
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of list) {
    const [pair] = c.split(";");
    const [k, ...v] = (pair ?? "").split("=");
    if (k?.trim() === name) return decodeURIComponent(v.join("=").trim());
  }
  return null;
}

const pglite = new PGlite("memory://");
await runMigrations(pglite);

const config = loadConfig({
  nodeEnv: "test",
  logLevel: "warn",
  baseUrl: BASE_URL,
  sessionSecret: "e2e-secret-0123456789abcdef0123456789abcdef",
  port: PORT,
  host: HOST,
});

const db = drizzle(pglite, { schema }) as unknown as Db;
const { app, auth } = await buildApp({
  config,
  database: {
    db,
    dialect: new PGliteDialect({ pglite }),
    close: () => pglite.close(),
  },
});

await seedDatabase(db as unknown as SeedDb);

/** Decrypted base32 TOTP secret for a user (same path as test/flow-helpers). */
async function decryptedTotpSecret(userId: string): Promise<string> {
  const rows = await db
    .select()
    .from(authTwoFactor)
    .where(eq(authTwoFactor.userId, userId))
    .limit(1);
  if (!rows[0]) throw new Error("no twoFactor row");
  const ctx = await auth.$context;
  return symmetricDecrypt({ key: ctx.secretConfig, data: rows[0].secret });
}

/** Complete onboarding through the real HTTP endpoints (inject, no browser). */
async function onboard(token: string, userId: string, password: string): Promise<void> {
  const post = (
    url: string,
    payload: NonNullable<InjectOptions["payload"]>,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url, headers: ORIGIN, payload });

  const verify = await post("/api/onboarding/verify-token", { token });
  if (verify.statusCode !== 200) throw new Error(`verify-token: ${verify.body}`);
  const setPw = await post("/api/onboarding/set-password", { token, password });
  if (setPw.statusCode !== 200) throw new Error(`set-password: ${setPw.body}`);
  const enable = await post("/api/onboarding/totp-enable", { token });
  if (enable.statusCode !== 200) throw new Error(`totp-enable: ${enable.body}`);

  const secret = await decryptedTotpSecret(userId);
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
  const verifyTotp = await post("/api/onboarding/totp-verify", { token, code });
  if (verifyTotp.statusCode !== 200) throw new Error(`totp-verify: ${verifyTotp.body}`);
}

/** Full login via inject → session cookie value (from flow-helpers login()). */
async function loginSession(email: string, password: string): Promise<string> {
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: ORIGIN,
    payload: { email, password },
  });
  if (signIn.statusCode !== 200) throw new Error(`sign-in: ${signIn.body}`);
  const twoFactorCookie = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
  if (!twoFactorCookie) throw new Error(`expected 2FA challenge: ${signIn.body}`);

  const rows = await db
    .select({ id: schema.authUser.id })
    .from(schema.authUser)
    .where(eq(schema.authUser.email, email))
    .limit(1);
  if (!rows[0]) throw new Error(`user ${email} not found`);
  const secret = await decryptedTotpSecret(rows[0].id);
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/two-factor/verify-totp",
    headers: { ...ORIGIN, cookie: `payroll.two_factor=${twoFactorCookie}` },
    payload: { code },
  });
  if (verify.statusCode !== 200) throw new Error(`verify-totp: ${verify.body}`);
  const session = cookieValue(verify.headers["set-cookie"], "payroll.session_token");
  if (!session) throw new Error("no session cookie after 2FA verify");
  return session;
}

// ---------------------------------------------------------------- fixtures
// Admin: fully onboarded (journey 2/3 log in via the browser with computed
// TOTP codes from the secret in the state file).
const adminInvite = await inviteUser(
  { auth, db, config },
  { name: ADMIN.name, email: ADMIN.email, role: "admin" },
  null,
);
const adminToken = new URL(adminInvite.setupLink).searchParams.get("token");
if (!adminToken) throw new Error("no admin invite token");
await onboard(adminToken, adminInvite.userId, ADMIN_PASSWORD);
const adminTotpSecret = await decryptedTotpSecret(adminInvite.userId);

// Employee: invited only — journey 1 completes onboarding in the browser.
const empInvite = await inviteUser(
  { auth, db, config },
  { name: EMPLOYEE.name, email: EMPLOYEE.email, role: "employee" },
  null,
);

// Employee record + monthly compensation so payroll generation has inputs.
const companyRows = await db.select({ id: company.id }).from(company).limit(1);
if (!companyRows[0]) throw new Error("seed did not create a company");
const [empRow] = await db
  .insert(employees)
  .values({
    userId: empInvite.userId,
    companyId: companyRows[0].id,
    legalName: EMPLOYEE.name,
    hireDate: "2024-01-01",
  })
  .returning();
if (!empRow) throw new Error("employee insert returned nothing");
await db.insert(compensation).values({
  employeeId: empRow.id,
  periodAmount: "4000",
  frequency: "monthly",
  effectiveFrom: "2025-01-01",
  effectiveTo: null,
});

// Draft payroll run (2025-11) through the real admin endpoint — the same
// $4,000/mo inputs as the synthetic engine golden case (net $3,383.87).
const adminCookie = await loginSession(ADMIN.email, ADMIN_PASSWORD);
const gen = await app.inject({
  method: "POST",
  url: "/api/admin/payroll-runs/generate",
  headers: { ...ORIGIN, cookie: `payroll.session_token=${adminCookie}` },
  payload: { year: 2025, month: 11, employeeId: empRow.id },
});
if (gen.statusCode !== 201) throw new Error(`generate: ${gen.body}`);
const runPublicId = (gen.json() as { generated: { publicId: string }[] }).generated[0]?.publicId;
if (!runPublicId) throw new Error("generate returned no run");

mkdirSync(dirname(STATE_FILE), { recursive: true });
writeFileSync(
  STATE_FILE,
  `${JSON.stringify(
    {
      baseUrl: BASE_URL,
      admin: { email: ADMIN.email, password: ADMIN_PASSWORD, totpSecret: adminTotpSecret },
      employee: { email: EMPLOYEE.email, inviteUrl: empInvite.setupLink },
      run: { publicId: runPublicId },
    },
    null,
    2,
  )}\n`,
);

await app.listen({ port: PORT, host: HOST });
console.log(`e2e:serve ready at ${BASE_URL} (state → ${STATE_FILE})`);

const shutdown = () => {
  void app.close().then(() => pglite.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
