/**
 * Journey steps with per-step stills (spec 20, PAY-78).
 *
 * `step(page, title, body)` wraps `test.step` and, at the end of the step —
 * including a step that throws — attaches one full-height JPEG of `page`. The
 * evidence reporter (../../reporters/evidence-reporter.ts) records each step
 * with its still, and the pay-verify dashboard shows them beside the step list.
 *
 * The page is passed explicitly: payroll journeys switch between separately
 * created browser contexts (admin, employee), so there is no single built-in
 * `page` to capture.
 *
 * Stills are taken only in the ephemeral boot (spec 20 D2): never when
 * E2E_BASE_URL points the suite at live QA. Every step is captured — all e2e
 * data is synthetic, so there is no step denylist.
 *
 * apps/web scrolls the document (`#app { min-height: 100vh }`), so a fullPage
 * screenshot is the whole screen. The capture checks that assumption every
 * time: if a large inner scroller hides content, the still is refused and the
 * step records no still (an annotation says why) instead of a one-viewport
 * image that looks whole.
 */

import { rm } from "node:fs/promises";
import { test, type Page, type TestInfo } from "@playwright/test";
import {
  STEP_STILL_ATTACHMENT,
  STEP_STILL_META_ATTACHMENT,
  STILL_MISSING_ANNOTATION,
  type StillMeta,
} from "../../reporters/evidence-reporter.js";
import { LIVE_QA } from "../qa.js";

/** A still never exceeds this height (CSS px), however long the page. */
export const STILL_MAX_HEIGHT_PX = 4000;
/** JPEG quality: small enough to serve one file per step. */
const STILL_JPEG_QUALITY = 70;
/**
 * An inner scroller at least this share of the viewport tall is treated as
 * the page's main content. Smaller ones (a dropdown's option list, a code
 * box) are part of the screen, not a second page.
 */
const MAIN_SCROLLER_MIN_VIEWPORT_SHARE = 0.5;
/** Hidden pixels an inner scroller may have before it counts (layout rounding). */
const INNER_SCROLL_TOLERANCE_PX = 1;
/** The screenshot's own bound (ms): the config sets no actionTimeout. */
const STILL_SCREENSHOT_TIMEOUT_MS = 10_000;
/**
 * Bound on the whole capture (ms). A stuck page must not hang the step until
 * the test timeout, which would replace the step's own result.
 */
const STILL_CAPTURE_TIMEOUT_MS = 15_000;

/** Stills only in the ephemeral boot — never against live QA (spec 20 D2). */
export const STILLS_ENABLED = !LIVE_QA;

/**
 * In the page: how the screen scrolls. `document` is the document's own hidden
 * height; `inner` is the most any large visible inner scroller hides.
 */
function measureScroll(minShare: number): { document: number; inner: number; height: number } {
  const root = document.scrollingElement ?? document.documentElement;
  let inner = 0;
  for (const el of Array.from(document.body.getElementsByTagName("*"))) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (el.clientHeight < window.innerHeight * minShare) continue;
    if (!el.checkVisibility()) continue;
    inner = Math.max(inner, el.scrollHeight - el.clientHeight);
  }
  return {
    document: Math.max(0, root.scrollHeight - window.innerHeight),
    inner,
    height: root.scrollHeight,
  };
}

/**
 * Take the step's still: the whole document, cut at STILL_MAX_HEIGHT_PX and
 * flagged `truncated` when cut — never silently cropped.
 */
async function captureStill(page: Page, testInfo: TestInfo, index: number): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("page has no fixed viewport");
  const scroll = await page.evaluate(measureScroll, MAIN_SCROLLER_MIN_VIEWPORT_SHARE);
  if (scroll.inner > INNER_SCROLL_TOLERANCE_PX) {
    throw new Error(
      `inner-scroller: a large inner scroller hides ${scroll.inner}px; a fullPage still would show one viewport`,
    );
  }
  const fullHeight = Math.max(viewport.height, scroll.height);
  const height = Math.min(fullHeight, STILL_MAX_HEIGHT_PX);
  const path = testInfo.outputPath(`step-still-${String(index).padStart(2, "0")}.jpg`);
  await page.screenshot({
    path,
    type: "jpeg",
    quality: STILL_JPEG_QUALITY,
    fullPage: true,
    clip: { x: 0, y: 0, width: viewport.width, height },
    // CSS pixels: the height cap bounds the file on any device scale.
    scale: "css",
    animations: "disabled",
    timeout: STILL_SCREENSHOT_TIMEOUT_MS,
  });
  const meta: StillMeta = { width: viewport.width, height, truncated: fullHeight > height };
  // Attached inside the step body, so the reporter attributes them to this step.
  // attach() copies the file into the attachments dir (named by a hash of the
  // source path) before it resolves; drop the original so the uploaded
  // evidence holds each still once.
  await testInfo.attach(STEP_STILL_ATTACHMENT, { path, contentType: "image/jpeg" });
  await rm(path, { force: true });
  await testInfo.attach(STEP_STILL_META_ATTACHMENT, {
    body: JSON.stringify(meta),
    contentType: "application/json",
  });
}

/** Reject after `ms`, so a hung capture settles instead of hanging the step. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capture timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Per-test step counter, so still file names are unique within a test attempt. */
const stepCounters = new WeakMap<TestInfo, number>();

/**
 * Run `body` as a named journey step and attach a still of `page` at its end.
 *
 * A failing step still gets its still — the screen it failed on is the most
 * useful evidence on a red card. A capture error never replaces the step's own
 * result: it is recorded as an annotation and the step has no still.
 */
export async function step<T>(page: Page, title: string, body: () => Promise<T>): Promise<T> {
  return test.step(title, async () => {
    const testInfo = test.info();
    const index = stepCounters.get(testInfo) ?? 0;
    stepCounters.set(testInfo, index + 1);
    if (!STILLS_ENABLED) return body();
    const browserName = page.context().browser()?.browserType().name();
    if (browserName !== "chromium") {
      throw new Error(`journey stills are chromium-only; this page runs on ${browserName}`);
    }
    try {
      return await body();
    } finally {
      await within(STILL_CAPTURE_TIMEOUT_MS, captureStill(page, testInfo, index)).catch(
        (err: unknown) => {
          testInfo.annotations.push({
            type: STILL_MISSING_ANNOTATION,
            description: `${title}: ${err instanceof Error ? err.message : String(err)}`,
          });
        },
      );
    }
  });
}
