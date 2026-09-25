/**
 * Spec 20 (PAY-78): the journey `step` helper's still capture, on synthetic
 * pages (page.setContent) — no app, no login, no shared state.
 */

import { existsSync } from "node:fs";
import { expect, test, type TestInfo } from "@playwright/test";
import {
  STEP_STILL_ATTACHMENT,
  STEP_STILL_META_ATTACHMENT,
  STILL_MISSING_ANNOTATION,
  type StillMeta,
} from "../reporters/evidence-reporter.js";
import { STILL_MAX_HEIGHT_PX, STILLS_ENABLED, step } from "./support/journey.js";

test.skip(!STILLS_ENABLED, "stills are ephemeral-only (spec 20 D2)");

/** Every still meta attached so far in this test, in order. */
function metas(testInfo: TestInfo): StillMeta[] {
  return testInfo.attachments
    .filter((a) => a.name === STEP_STILL_META_ATTACHMENT)
    .map((a) => JSON.parse(String(a.body)) as StillMeta);
}

function stills(testInfo: TestInfo): string[] {
  return testInfo.attachments
    .filter((a) => a.name === STEP_STILL_ATTACHMENT)
    .map((a) => a.path ?? "");
}

function tallHtml(heightPx: number): string {
  return `<!doctype html><body style="margin:0"><div style="height:${heightPx}px;background:linear-gradient(#fff,#39f)">tall</div></body>`;
}

test.describe("harness · journey stills", () => {
  test("a short page gives one untruncated still at the viewport height", async ({ page }) => {
    await page.setContent(tallHtml(200));
    await step(page, "short page", async () => {});
    const viewport = page.viewportSize();
    expect(metas(test.info())).toEqual([
      { width: viewport?.width, height: viewport?.height, truncated: false },
    ]);
    expect(stills(test.info())).toHaveLength(1);
  });

  test("a tall page is captured in full below the cap", async ({ page }) => {
    await page.setContent(tallHtml(2500));
    await step(page, "tall page", async () => {});
    const [meta] = metas(test.info());
    expect(meta?.height).toBe(2500);
    expect(meta?.truncated).toBe(false);
  });

  test("a page over the cap is cut at the cap and flagged truncated", async ({ page }) => {
    await page.setContent(tallHtml(STILL_MAX_HEIGHT_PX + 1500));
    await step(page, "very tall page", async () => {});
    const [meta] = metas(test.info());
    expect(meta?.height).toBe(STILL_MAX_HEIGHT_PX);
    expect(meta?.truncated).toBe(true);
  });

  test("a large inner scroller refuses the still and says why", async ({ page }) => {
    await page.setContent(
      `<!doctype html><body style="margin:0"><main style="height:100vh;overflow-y:auto">${tallHtml(3000)}</main></body>`,
    );
    await step(page, "inner scroller", async () => {});
    expect(stills(test.info())).toEqual([]);
    const note = test.info().annotations.find((a) => a.type === STILL_MISSING_ANNOTATION);
    expect(note?.description).toContain("inner scroller: inner-scroller");
  });

  test("a small inner scroller (a dropdown list) does not block the still", async ({ page }) => {
    await page.setContent(
      `<!doctype html><body style="margin:0"><ul style="height:80px;overflow-y:auto">${"<li>x</li>".repeat(40)}</ul></body>`,
    );
    await step(page, "dropdown", async () => {});
    expect(stills(test.info())).toHaveLength(1);
  });

  test("a failing step still gets its still, and its own error propagates", async ({ page }) => {
    await page.setContent(tallHtml(300));
    const err = await step(page, "fails", async () => {
      throw new Error("boom");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    expect(stills(test.info())).toHaveLength(1);
  });

  test("each step in a test gets its own still file", async ({ page }) => {
    await page.setContent(tallHtml(300));
    await step(page, "one", async () => {});
    await page.setContent(tallHtml(600));
    await step(page, "two", async () => {});
    const files = stills(test.info());
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    expect(files.every((f) => existsSync(f))).toBe(true);
  });

  test("step returns the body's value", async ({ page }) => {
    await page.setContent(tallHtml(100));
    expect(await step(page, "value", async () => 42)).toBe(42);
  });
});
