/**
 * Spec 20 (PAY-78, owner ruling R3): the walkthrough's cursor overlay, on
 * synthetic pages (page.setContent) — no app, no login.
 */

import { type Browser, expect, type Page, type TestInfo, test } from "@playwright/test";
import { OVERLAY_GLIDE_MS, OVERLAY_HIGHLIGHT_MS } from "./support/overlay.js";
import { registerPage } from "./support/walkthrough.js";

/** Run `body` on a recorded, walkthrough-registered page with `html` as its content. */
async function withRegisteredPage(
  browser: Browser,
  testInfo: TestInfo,
  html: string,
  body: (page: Page) => Promise<void>,
  beforeRegister?: (page: Page) => Promise<void>,
): Promise<void> {
  const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputPath("v") } });
  const page = await ctx.newPage();
  try {
    await page.setContent(html);
    await beforeRegister?.(page);
    await registerPage(page, testInfo);
    await body(page);
  } finally {
    await ctx.close();
  }
}

/** In the page: the overlay host and one of its shadow-root parts. */
const OVERLAY_STATE = () => {
  const host = document.querySelector("walkthrough-overlay") as HTMLElement | null;
  const part = (name: string) => host?.shadowRoot?.querySelector<HTMLElement>(`[part~="${name}"]`);
  return {
    kind: host?.dataset.ringKind,
    caption: part("caption")?.dataset.text,
    ringOpacity: part("ring")?.style.opacity,
  };
};

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
      const part = (name: string) =>
        host?.shadowRoot?.querySelector<HTMLElement>(`[part~="${name}"]`);
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(part("cursor")?.style.transform ?? "");
      const box = part("ring")?.getBoundingClientRect();
      (window as unknown as { __atClick: AtClick }).__atClick = {
        ringOpacity: part("ring")?.style.opacity ?? "",
        ringKind: host?.dataset.ringKind,
        caption: part("caption")?.dataset.text ?? "",
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
    await withRegisteredPage(
      browser,
      testInfo,
      `<main style="padding:200px"><button id="save" style="width:120px;height:40px">Save</button></main>`,
      async (page) => {
        await page.getByRole("button", { name: "Save" }).click();
        const at = await page.evaluate(
          () => (window as unknown as { __atClick: AtClick }).__atClick,
        );
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
        expect((await page.evaluate(OVERLAY_STATE)).ringOpacity).toBe("0");
      },
      (page) => page.evaluate(RECORD_AT_CLICK),
    );
  });

  test("a field being typed into keeps a dashed focus ring", async ({ browser }, testInfo) => {
    await withRegisteredPage(
      browser,
      testInfo,
      `<label>Name <input id="n"></label>`,
      async (page) => {
        await page.getByLabel("Name").fill("Ada");
        const state = await page.evaluate(OVERLAY_STATE);
        expect({ kind: state.kind, caption: state.caption }).toEqual({
          kind: "focus",
          caption: "Type · Name",
        });
      },
    );
  });

  test("the caption is invisible to text locators: no strict-mode double match", async ({
    browser,
  }, testInfo) => {
    await withRegisteredPage(
      browser,
      testInfo,
      `<button>Save</button> <p>Total $3,383.87</p>`,
      async (page) => {
        // The pointed-at action's own locator, and a later one, each match once.
        await page.getByText("Save").click();
        await page.getByText("Total $3,383.87").click();
        await expect(page.getByText("Save")).toHaveCount(1);
        await expect(page.getByText("$3,383.87")).toHaveCount(1);
      },
    );
  });

  test("an unregistered page never gets the overlay", async ({ page }) => {
    await page.setContent(`<button>Save</button>`);
    await page.getByRole("button", { name: "Save" }).click();
    expect(await page.locator("walkthrough-overlay").count()).toBe(0);
  });

  test("pointing is not a screen change: no extra hold on the same screen", async ({
    browser,
  }, testInfo) => {
    await withRegisteredPage(
      browser,
      testInfo,
      `<button id="a">A</button> <button id="b">B</button>`,
      async (page) => {
        await page.locator("#a").click();
        // Same screen: only the glide + highlight, never another hold.
        const t = Date.now();
        await page.locator("#b").click();
        expect(Date.now() - t).toBeLessThan(OVERLAY_GLIDE_MS + OVERLAY_HIGHLIGHT_MS + 400);
      },
    );
  });
});
