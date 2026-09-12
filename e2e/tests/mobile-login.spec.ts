/**
 * Mobile-viewport regression (PAY-28): the login card used to span the full
 * phone width with zero gutter — every control glued to the screen edges at
 * ≤380px ("mobile login view is broken"). Read-only, so it runs in both
 * ephemeral and live-QA modes.
 */

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 700 } }); // iPhone-class width

test("login form keeps a gutter and never overflows horizontally at 375px", async ({ page }) => {
  await page.goto("/login");

  const card = page.locator(".auth-card");
  await expect(card.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // No horizontal scroll anywhere on the page.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Controls sit inside the 1rem gutter, not on the screen edges.
  const email = page.locator("#email");
  const box = await email.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(15); // 16px padding, 1px tolerance
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);

  // Password wrapper + submit button share the same inset.
  const password = page.locator(".p-password");
  const pBox = await password.boundingBox();
  expect(pBox!.x).toBeGreaterThanOrEqual(15);
  expect(pBox!.x + pBox!.width).toBeLessThanOrEqual(360);

  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  const sBox = await submit.boundingBox();
  expect(sBox!.x).toBeGreaterThanOrEqual(15);
  expect(sBox!.x + sBox!.width).toBeLessThanOrEqual(360);
});
