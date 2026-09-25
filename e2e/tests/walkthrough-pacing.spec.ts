/**
 * Spec 20 (PAY-78): walkthrough pacing on a registered page — synthetic pages
 * only (page.setContent), no app, no login.
 *
 * Registering wraps the Locator/Page prototypes for this worker, but only a
 * registered page is ever held or typed into slowly, so the other tests in the
 * run are untouched (asserted below too).
 */

import { expect, test } from "@playwright/test";
import { registerPage, WALKTHROUGH_HOLD_MS } from "./support/walkthrough.js";

test.describe("harness · walkthrough pacing", () => {
  test("a changed screen is held before the next action; an unchanged one is not", async ({
    browser,
  }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(
        `<main><h1>List</h1><button id="go">Go</button><button id="again">Again</button></main>`,
      );
      await registerPage(page, testInfo);

      // Same screen as registered: no hold.
      let t = Date.now();
      await page.locator("#again").click();
      expect(Date.now() - t).toBeLessThan(WALKTHROUGH_HOLD_MS - 300);

      // A dialog opens (a new screen): the next action waits for the hold.
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.setAttribute("role", "dialog");
        d.textContent = "Confirm?";
        document.body.append(d);
      });
      t = Date.now();
      await page.locator("#go").click();
      expect(Date.now() - t).toBeGreaterThanOrEqual(WALKTHROUGH_HOLD_MS - 50);

      // Held once: the following action on the same screen runs straight away.
      t = Date.now();
      await page.locator("#again").click();
      expect(Date.now() - t).toBeLessThan(WALKTHROUGH_HOLD_MS - 300);
    } finally {
      await ctx.close();
    }
  });

  test("fill on a registered page types one character at a time", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(`<input id="f" value="old">`);
      await page.evaluate(() => {
        const w = window as unknown as { __inputs: number };
        w.__inputs = 0;
        document.getElementById("f")?.addEventListener("input", () => {
          w.__inputs += 1;
        });
      });
      await registerPage(page, testInfo);
      await page.locator("#f").fill("ISSUE");
      await expect(page.locator("#f")).toHaveValue("ISSUE");
      // clear() = 1 input event, then one per character.
      const inputs = await page.evaluate(
        () => (window as unknown as { __inputs: number }).__inputs,
      );
      expect(inputs).toBeGreaterThanOrEqual(5);
    } finally {
      await ctx.close();
    }
  });

  test("an unregistered page is untouched: fill is one input, no hold", async ({ page }) => {
    await page.setContent(`<input id="f"><div role="dialog">x</div>`);
    await page.evaluate(() => {
      const w = window as unknown as { __inputs: number };
      w.__inputs = 0;
      document.getElementById("f")?.addEventListener("input", () => {
        w.__inputs += 1;
      });
    });
    const t = Date.now();
    await page.locator("#f").fill("ISSUE");
    expect(Date.now() - t).toBeLessThan(WALKTHROUGH_HOLD_MS - 300);
    expect(await page.evaluate(() => (window as unknown as { __inputs: number }).__inputs)).toBe(1);
  });

  test("a page that is not being recorded is refused, never silently skipped", async ({
    browser,
  }, testInfo) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await expect(registerPage(page, testInfo)).rejects.toThrow(/not being recorded/);
    } finally {
      await ctx.close();
    }
  });
});
