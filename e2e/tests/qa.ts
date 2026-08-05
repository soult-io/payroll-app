/**
 * Shared fixtures/helpers for the live-QA e2e specs (spec 14 §3).
 *
 * Credentials here are the FIXED, DOCUMENTED, FAKE QA-only logins created by
 * `pnpm seed:qa` (docs/qa.md) — publishing them is deliberate: they guard a
 * synthetic-data environment only. The TOTP values are the RAW secrets
 * (createOTP HMAC keys, exactly as seeded into the twoFactor table); the
 * base32-encoded forms for authenticator apps are documented in docs/qa.md.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";

export const LIVE_QA = Boolean(process.env.E2E_BASE_URL);

export const QA_ADMIN = {
  email: "qa-admin@example.test",
  password: "qa-admin-passphrase-742",
  totpSecret: "QAADMIN0FIXED1TOTP2SECRET3SEED456",
};

export const QA_EMPLOYEE = {
  email: "qa-employee@example.test",
  password: "qa-employee-passphrase-318",
  totpSecret: "QAEMPLOYEE0FIXED1TOTP2SECRET3SEED",
};

/** Export-token bearer for the QA-only mailbox endpoint (GitHub secret in CI). */
export const QA_EXPORT_TOKEN = process.env.E2E_QA_EXPORT_TOKEN ?? "";

export async function totp(secret: string): Promise<string> {
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

/** Fill the login TOTP challenge and submit, retrying once on a period boundary. */
async function submitLoginTotp(page: Page, secret: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator("#totp").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const landed = await page
      .waitForURL("**/my/dashboard", { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return;
    if (attempt === 1) throw new Error("login TOTP failed twice");
  }
}

/** Full browser login: password step → TOTP challenge → dashboard. */
export async function loginAs(
  page: Page,
  user: { email: string; password: string; totpSecret: string },
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password input").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#totp")).toBeVisible();
  await submitLoginTotp(page, user.totpSecret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Ephemeral-mode fixture state (e2e:serve boot output), used by specs that
// also run against the local PGlite server.
// ---------------------------------------------------------------------------

export interface EphemeralState {
  baseUrl: string;
  admin: { email: string; password: string; totpSecret: string };
  employee: { email: string; inviteUrl: string };
  run: { publicId: string };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "../.state");

export function loadEphemeralState(): EphemeralState | null {
  try {
    return JSON.parse(readFileSync(resolve(STATE_DIR, "state.json"), "utf8")) as EphemeralState;
  } catch {
    return null;
  }
}

export const EMPLOYEE_SESSION_PATH = resolve(STATE_DIR, "employee-storage.json");
