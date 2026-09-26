/**
 * Spec 22 (PAY-66): the product name ("Wagon Payroll" by default) reaches the
 * login page from GET /api/runtime-config. Read-only, so it runs in both
 * ephemeral and live-QA modes (neither sets BRAND_NAME).
 */

import { expect, test } from "@playwright/test";

test("login page shows the product name in the tab title and the card", async ({ page }) => {
  await page.goto("/login");

  await expect(page).toHaveTitle("Wagon Payroll");

  const card = page.locator(".auth-card");
  await expect(card.locator(".auth-brand")).toHaveText("Wagon Payroll");
  // The brand line is not a heading: "Sign in" stays the card's heading.
  await expect(card.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Wagon Payroll" })).toHaveCount(0);
});
