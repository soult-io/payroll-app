/**
 * Spec 20 (PAY-78, owner ruling R3): the walkthrough's cursor overlay, on
 * synthetic pages (page.setContent) — no app, no login.
 */

import { expect, test } from "@playwright/test";
import { registerPage, WALKTHROUGH_HOLD_MS } from "./support/walkthrough.js";

/** What the overlay showed at the instant a click reached the page. */
interface AtClick {
  ringOpacity: string;
  ringKind: string | undefined;
  caption: string;
  cursor: { x: number; y: number } | null;
  ring: { left: number; top: number; right: number; bottom: number };
}

/**
 * Record the overlay's state when the click arrives — from a window capture
 * listener registered before the overlay exists, so it runs before the
 * overlay lets the ring go.
 */
const RECORD_AT_CLICK = () => {
  window.addEventListener(
    "click",
    () => {
      const host = document.querySelector("walkthrough-overlay") as HTMLElement | null;
      const root = host?.shadowRoot;
      const ring = root?.querySelector<HTMLElement>('[part~="ring"]');
      const cursor = root?.querySelector<HTMLElement>('[part~="cursor"]');
      const caption = root?.querySelector<HTMLElement>('[part~="caption"]');
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(cursor?.style.transform ?? "");
      const box = ring?.getBoundingClientRect();
      (window as unknown as { __atClick: AtClick }).__atClick = {
        ringOpacity: ring?.style.opacity ?? "",
        ringKind: host?.dataset.ringKind,
        caption: caption?.dataset.text ?? "",
        cursor: m ? { x: Number(m[1]), y: Number(m[2]) } : null,
        ring: {
          left: box?.left ?? 0,
          top: box?.top ?? 0,
          right: box?.right ?? 0,
          bottom: box?.bottom ?? 0,
        },
      };
    },
    { capture: true },
  );
};

test.describe("harness · walkthrough overlay", () => {
  test("at the click, the cursor is inside the ring and the caption names the target", async ({
    browser,
  }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(
        `<main style="padding:200px"><button id="save" style="width:120px;height:40px">Save</button></main>`,
      );
      await page.evaluate(RECORD_AT_CLICK);
      await registerPage(page, testInfo);
      await page.getByRole("button", { name: "Save" }).click();
      const at = await page.evaluate(() => (window as unknown as { __atClick: AtClick }).__atClick);
      expect(at.ringOpacity).toBe("1");
      expect(at.ringKind).toBe("click");
      expect(at.caption).toBe("Click · Save");
      const c = at.cursor;
      expect(c).not.toBeNull();
      if (c) {
        expect(c.x).toBeGreaterThanOrEqual(at.ring.left);
        expect(c.x).toBeLessThanOrEqual(at.ring.right);
        expect(c.y).toBeGreaterThanOrEqual(at.ring.top);
        expect(c.y).toBeLessThanOrEqual(at.ring.bottom);
      }
      // The ring lets go at the click.
      const after = await page.evaluate(
        () =>
          document
            .querySelector("walkthrough-overlay")
            ?.shadowRoot?.querySelector<HTMLElement>('[part~="ring"]')?.style.opacity,
      );
      expect(after).toBe("0");
    } finally {
      await ctx.close();
    }
  });

  test("a field being typed into keeps a dashed focus ring", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(`<label>Name <input id="n"></label>`);
      await registerPage(page, testInfo);
      await page.getByLabel("Name").fill("Ada");
      const state = await page.evaluate(() => {
        const host = document.querySelector("walkthrough-overlay") as HTMLElement | null;
        return {
          kind: host?.dataset.ringKind,
          caption: host?.shadowRoot?.querySelector<HTMLElement>('[part~="caption"]')?.dataset.text,
        };
      });
      expect(state).toEqual({ kind: "focus", caption: "Type · Name" });
    } finally {
      await ctx.close();
    }
  });

  test("the caption is invisible to text locators: no strict-mode double match", async ({
    browser,
  }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(`<button>Save</button> <p>Total $3,383.87</p>`);
      await registerPage(page, testInfo);
      // The pointed-at action's own locator, and a later one, each match once.
      await page.getByText("Save").click();
      await page.getByText("Total $3,383.87").click();
      await expect(page.getByText("Save")).toHaveCount(1);
      await expect(page.getByText("$3,383.87")).toHaveCount(1);
    } finally {
      await ctx.close();
    }
  });

  test("an unregistered page never gets the overlay", async ({ page }) => {
    await page.setContent(`<button>Save</button>`);
    await page.getByRole("button", { name: "Save" }).click();
    expect(await page.locator("walkthrough-overlay").count()).toBe(0);
  });

  test("pointing is not a screen change: no extra hold on the same screen", async ({
    browser,
  }, testInfo) => {
    const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
    const page = await ctx.newPage();
    try {
      await page.setContent(`<button id="a">A</button> <button id="b">B</button>`);
      await registerPage(page, testInfo);
      await page.locator("#a").click();
      // Same screen: only the glide + highlight (~950ms), never another hold.
      const t = Date.now();
      await page.locator("#b").click();
      expect(Date.now() - t).toBeLessThan(WALKTHROUGH_HOLD_MS + 400);
    } finally {
      await ctx.close();
    }
  });
});
