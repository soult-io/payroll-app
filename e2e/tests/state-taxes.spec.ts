/**
 * PAY-13 phase 1 e2e — state withholding admin surfaces.
 *
 * Read-only everywhere (safe for live QA): the "State taxes" tab renders on
 * the admin config page and the "State tax" tab on an employee detail page.
 * The mutating flow (assign work state → it appears in the history table)
 * runs only against the ephemeral PGlite boot, per spec 14 §3.
 *
 * All logins go through newAuthedPage's per-worker session cache — the API
 * rate-limits credential endpoints (spec 3), and raw loginAs calls in a new
 * spec file hit the 429 wall when suites run together.
 */

import { expect, test, type Page } from "@playwright/test";
import { LIVE_QA, loadEphemeralState, newAuthedPage, QA_ADMIN } from "./qa.js";

function adminUser() {
  return LIVE_QA ? QA_ADMIN : loadEphemeralState()?.admin;
}

/** Open the first employee's detail page and switch to the State tax tab. */
async function openStateTaxTab(page: Page) {
  await page.goto("/admin/employees");
  await page.locator("tbody tr").first().click();
  await page.waitForURL(/\/admin\/employees\/\d+/);
  await page.getByRole("tab", { name: "State tax" }).click();
}

test("config page: State taxes tab renders", async ({ browser }) => {
  const user = adminUser();
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await page.goto("/admin/config");
    await page.getByRole("tab", { name: "State taxes" }).click();
    await expect(page.getByText("Jurisdiction", { exact: true })).toBeVisible();
    await expect(page.getByText("Computation kind")).toBeVisible();
    await expect(page.getByText("resolution falls back to the bare state code")).toBeVisible();
  } finally {
    await page.close();
  }
});

test("employee detail: State tax tab renders work-state and election tables", async ({
  browser,
}) => {
  const user = adminUser();
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await openStateTaxTab(page);
    await expect(page.getByRole("heading", { name: "Work state (PAY-13)" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "State withholding elections (append-only)" }),
    ).toBeVisible();
  } finally {
    await page.close();
  }
});

test("ephemeral only: assign a work state and see it in the history", async ({ browser }) => {
  test.skip(LIVE_QA, "mutating — live QA is read-only (spec 14 §3)");
  const user = loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await openStateTaxTab(page);
    await page.getByRole("button", { name: "Assign" }).click();
    await page.getByLabel("State (USPS code)").fill("IL");
    await page.getByRole("button", { name: "Assign", exact: true }).last().click();
    await expect(page.getByText("Work state assigned")).toBeVisible();
    // Scope to the work-state card — inactive tab panels stay mounted, so a
    // bare tbody.first() would land in the hidden Compensation table.
    const workStateCard = page.locator("section", {
      has: page.getByRole("heading", { name: "Work state (PAY-13)" }),
    });
    await expect(workStateCard.getByRole("cell", { name: "IL", exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
});
