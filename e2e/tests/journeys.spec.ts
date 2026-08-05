/**
 * Critical user journeys (hardening B) — real browser against the real app:
 * built SPA served by Fastify, backed by in-memory PGlite (e2e:serve boot).
 *
 * Serial: journeys share the single in-memory database and build on each
 * other (journey 1 onboards the employee that 2 and 3 then use).
 *
 * TOTP is driven by computing codes from the enrollment secret with the same
 * @better-auth/utils OTP implementation the server uses (async — always
 * await .totp()). Codes rotate every 30s, so each submission retries once
 * with a fresh code when the first lands on a period boundary.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";

test.describe.configure({ mode: "serial" });

interface E2EState {
  baseUrl: string;
  admin: { email: string; password: string; totpSecret: string };
  employee: { email: string; inviteUrl: string };
  run: { publicId: string };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "../.state");
/**
 * Ephemeral-mode fixture state, written by @payroll/server's e2e:serve boot.
 * In live-QA mode (E2E_BASE_URL) there is no state file and these journeys
 * are skipped outright — live QA is a shared environment and the journeys
 * MUTATE data (onboarding, issuing payroll runs, approving change requests).
 */
const STATE = (
  process.env.E2E_BASE_URL
    ? null
    : JSON.parse(readFileSync(resolve(STATE_DIR, "state.json"), "utf8"))
) as E2EState;

test.skip(
  Boolean(process.env.E2E_BASE_URL),
  "journeys are ephemeral-fixture only — live QA is read-only (spec 14 §3)",
);

/**
 * Saved browser sessions (storageState, written into the gitignored .state
 * dir). The app rate-limits credential endpoints to 10 req/min — every fresh
 * login costs 2 (sign-in + TOTP verify) — so journey 1 (which exercises
 * login itself) saves the employee session and journey 2 saves the admin
 * session; later journeys restore them instead of logging in again.
 */
const EMPLOYEE_SESSION = resolve(STATE_DIR, "employee-storage.json");
const ADMIN_SESSION = resolve(STATE_DIR, "admin-storage.json");

const EMPLOYEE_PASSWORD = "e2e-employee-passphrase-47";
const NEW_ADDRESS = {
  line1: "742 Evergreen Terrace",
  city: "Springfield",
  state: "IL",
  zip: "62704",
  country: "US",
};

async function totp(secret: string): Promise<string> {
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
async function loginAs(
  page: Page,
  user: { email: string; password: string; secret: string },
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password input").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#totp")).toBeVisible();
  await submitLoginTotp(page, user.secret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

/** Sign out and assert we are back on the login screen. */
async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

test("journey 1: invite onboarding wizard → backup codes → fresh login with TOTP", async ({
  page,
}) => {
  await page.goto(STATE.employee.inviteUrl);

  // Step 1 — password (token verified on load).
  await expect(page.locator("#pw input")).toBeVisible();
  await page.locator("#pw input").fill(EMPLOYEE_PASSWORD);
  await page.locator("#pw2 input").fill(EMPLOYEE_PASSWORD);
  const totpEnable = page.waitForResponse(
    (r) => r.url().includes("/api/onboarding/totp-enable") && r.ok(),
  );
  await page.getByRole("button", { name: "Set password" }).click();

  // Step 2 — TOTP enrollment: secret from the intercepted totpURI payload.
  // NOTE: createOTP().url() base32-ENCODES the raw secret into the URI, while
  // totp()/verify() HMAC the raw string — decode before computing codes.
  const { totpURI } = (await (await totpEnable).json()) as { totpURI: string };
  const uriSecret = new URL(totpURI).searchParams.get("secret");
  if (!uriSecret) throw new Error(`no secret in totpURI: ${totpURI}`);
  const secret = new TextDecoder().decode(base32.decode(uriSecret));

  await expect(page.getByAltText("TOTP QR code")).toBeVisible();
  await page.locator("#code").fill(await totp(secret));
  await page.getByRole("button", { name: "Verify and finish setup" }).click();

  // Step 3 — backup codes shown once (10, server-side default).
  await expect(page.locator(".codes li").first()).toBeVisible();
  await expect(page.locator(".codes li")).toHaveCount(10);

  // Fresh login with password + TOTP → dashboard.
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  await page.waitForURL("**/login");
  await loginAs(page, {
    email: STATE.employee.email,
    password: EMPLOYEE_PASSWORD,
    secret,
  });

  // Log out and log in again — the session is genuinely re-establishable.
  await logout(page);
  await loginAs(page, {
    email: STATE.employee.email,
    password: EMPLOYEE_PASSWORD,
    secret,
  });

  // Save the session for journeys 2/3 (credential endpoints are rate-limited
  // 10/min — reusing storageState avoids spending logins there).
  await page.context().storageState({ path: EMPLOYEE_SESSION });
});

test("journey 2: admin approves + issues payroll run; employee sees payslip + PDF", async ({
  page,
  browser,
}) => {
  await loginAs(page, {
    email: STATE.admin.email,
    password: STATE.admin.password,
    secret: STATE.admin.totpSecret,
  });
  await page.context().storageState({ path: ADMIN_SESSION }); // journey 3 reuses it

  // Open the run review from the runs list. The list defaults to the current
  // year — our seeded run is 2025-11, so switch the year filter first.
  await page.goto("/admin/payroll");
  await page.locator(".p-select").first().click();
  await page.getByRole("option", { name: "2025" }).click();
  const row = page.locator("tr", { hasText: "Awaiting approval" }).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL(`**/admin/payroll/${STATE.run.publicId}`);
  await expect(page.locator(".p-tag", { hasText: "Awaiting approval" })).toBeVisible();
  await expect(page.getByText("$2,982.12")).toBeVisible(); // golden net pay, $3,500/mo

  // Approve → confirm dialog.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.locator(".p-confirmdialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".p-tag", { hasText: "Approved" })).toBeVisible();

  // Issue → type-to-confirm dialog.
  await page.getByRole("button", { name: "Issue payslip" }).click();
  await page.locator(".p-dialog input[placeholder='ISSUE']").fill("ISSUE");
  await page.locator(".p-dialog").getByRole("button", { name: "Issue payslip" }).click();
  await expect(page.locator(".p-tag", { hasText: "Issued" })).toBeVisible();

  // Employee session (separate context, restored from journey 1's saved
  // storageState): issued payslip visible + PDF bytes.
  const ctx = await browser.newContext({ storageState: EMPLOYEE_SESSION });
  const emp = await ctx.newPage();
  await emp.goto("/my/payslips");
  const slip = emp.locator("tr", { hasText: "$2,982.12" }).first();
  await expect(slip).toBeVisible();
  await slip.click();
  await emp.waitForURL(`**/my/payslips/${STATE.run.publicId}`);

  const pdf = await emp.request.get(`/api/payslips/${STATE.run.publicId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  const body = await pdf.body();
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  expect(body.length).toBeGreaterThan(2000);

  await ctx.close();
});

test("journey 3: address change request round-trip (employee → admin approve → applied)", async ({
  browser,
}) => {
  // Employee session restored from journey 1's storageState (rate-limit budget).
  const empCtx = await browser.newContext({ storageState: EMPLOYEE_SESSION });
  const page = await empCtx.newPage();
  await page.goto("/my/requests/new");
  await page
    .getByRole("button", { name: /Address/ })
    .first()
    .click();
  await page.locator("#line1").fill(NEW_ADDRESS.line1);
  await page.locator("#city").fill(NEW_ADDRESS.city);
  await page.locator("#state").fill(NEW_ADDRESS.state);
  await page.locator("#zip").fill(NEW_ADDRESS.zip);
  await page.locator("#country").fill(NEW_ADDRESS.country);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText(NEW_ADDRESS.line1)).toBeVisible(); // review shows payload
  await page.getByRole("button", { name: "Submit request" }).click();

  await page.waitForURL(/\/my\/requests\/[0-9a-f-]{36}/);
  await expect(page.locator(".p-tag", { hasText: "Pending" })).toBeVisible();
  const publicId = page.url().split("/").pop();
  if (!publicId) throw new Error("no publicId in request URL");

  // Admin reviews the diff and approves (session from journey 2's storageState).
  const ctx = await browser.newContext({ storageState: ADMIN_SESSION });
  const admin = await ctx.newPage();
  await admin.goto("/admin/requests");
  const row = admin.locator("tr", { hasText: "Address" }).first();
  await expect(row).toBeVisible();
  await row.click();
  await admin.waitForURL(`**/admin/requests/${publicId}`);
  await expect(admin.getByText(NEW_ADDRESS.line1)).toBeVisible(); // proposed
  await expect(admin.getByText("Not on file")).toBeVisible(); // current
  await admin.getByRole("button", { name: "Approve & apply" }).click();
  await expect(admin.locator(".p-tag", { hasText: "Approved" })).toBeVisible();
  await ctx.close();

  // Employee sees the decision and the profile reflects the new address.
  await page.reload();
  await expect(page.locator(".p-tag", { hasText: "Approved" })).toBeVisible();
  await page.goto("/my/profile");
  await expect(page.getByText(NEW_ADDRESS.line1)).toBeVisible();
  await expect(page.getByText(NEW_ADDRESS.city)).toBeVisible();
  await empCtx.close();
});
