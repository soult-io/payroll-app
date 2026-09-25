/**
 * Walkthrough mode (spec 20, PAY-78): a separate, NON-gating re-run of the
 * journeys at human pace, recorded as one video per journey.
 *
 * Owner rulings (spec 20):
 * - R1/R2: a video is only useful at human pace, and the RECORDING is slowed
 *   (slowMo + holds), never the playback.
 *
 * Pacing:
 * - slowMo (playwright.config.ts) pauses after every browser action;
 * - text is typed per character (`fill` becomes clear + pressSequentially);
 * - every step ends with a hold (see `holdStepEnd`, called by `step`);
 * - before any action, if the screen changed since it was last held — a new
 *   route, a dialog or dropdown, rows added — it is held first. Without this
 *   a screen reached mid-step flashes by in ~0.3s.
 *
 * Recording: `use.video` only records the fixture page, never a context from
 * `browser.newContext`, and payroll journeys switch between such contexts. So
 * every context goes through {@link newContext}, which adds `recordVideo` in
 * this mode, and `step` refuses a page that is not being recorded — a clip can
 * never go missing silently.
 *
 * Off walkthrough, nothing here changes behaviour: only registered pages are
 * held or typed into slowly, and pages are registered only in this mode.
 */

import { writeFileSync } from "node:fs";
import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

export const WALKTHROUGH = process.env.E2E_WALKTHROUGH === "1";

/** Every clip is this size, so clips join without re-encoding. */
export const VIDEO_SIZE = { width: 1280, height: 720 };
/** Pause added after every browser action (ms). */
export const WALKTHROUGH_SLOWMO_MS = 300;
/** How long a screen stays up before the recording moves on (ms). */
export const WALKTHROUGH_HOLD_MS = 1500;
/** Delay between typed characters (ms): a person typing, not a paste. */
const WALKTHROUGH_TYPE_DELAY_MS = 80;
/** Holds in a row before one action while the screen keeps changing. */
const WALKTHROUGH_MAX_HOLDS = 3;
/** How long an action first waits for its own target to exist (ms). */
const WALKTHROUGH_TARGET_WAIT_MS = 10_000;

/** Annotation per journey step: {@link StepMark} as JSON. */
export const STEP_MARK_ANNOTATION = "walkthrough-step";
/** Annotation per recorded page: {@link ClipMark} as JSON. */
export const CLIP_MARK_ANNOTATION = "walkthrough-clip";
/** Sidecar file (in the test's output dir) holding each clip's close instant. */
export const CLIP_CLOSE_FILE = "walkthrough-clip-close.json";

/** Where a step starts: which clip, and the wall-clock instant. */
export interface StepMark {
  index: number;
  title: string;
  clip: number;
  startedAt: number;
}

/** One recorded page. */
export interface ClipMark {
  clip: number;
  video: string;
  /**
   * Wall-clock instant of the recording's first frame, when known exactly
   * (see markRecordingStart); null for a page that painted before it could be
   * stamped, whose start is then estimated from its close.
   */
  recordingStartedAt: number | null;
  /** Sidecar file the clip's close instant is written to. */
  closeFile: string;
}

/**
 * Create a browser context. In walkthrough mode it records video; otherwise it
 * is exactly `browser.newContext(options)`.
 */
export async function newContext(
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0] = {},
  testInfo?: TestInfo,
): Promise<BrowserContext> {
  if (!WALKTHROUGH) return browser.newContext(options);
  const info = testInfo ?? test.info();
  const ctx = await browser.newContext({
    ...options,
    viewport: VIDEO_SIZE,
    recordVideo: { dir: info.outputPath("videos"), size: VIDEO_SIZE },
  });
  // Stamp every page's recording start the moment it exists, before a test
  // can navigate it (a login before the first step would otherwise leave the
  // start unknown).
  const newPage = ctx.newPage.bind(ctx);
  ctx.newPage = async () => {
    const page = await newPage();
    await markRecordingStart(page);
    return page;
  };
  return ctx;
}

/** Exact recording start per page, stamped by markRecordingStart. */
const recordingStarts = new WeakMap<Page, number>();

/**
 * A page's video starts at its first PAINT — not at page creation, and a
 * blank page paints nothing. So paint a plain grey frame now (white would not
 * count as a paint) and stamp the instant. Only on a blank page: painting over
 * a page that has content would lose its state.
 *
 * Anchoring at the start is exact. The fallback — close instant minus the
 * file's duration — runs late: recording continues briefly after the page's
 * close event, which cut the first screen of a clip short in the first CI run.
 */
async function markRecordingStart(page: Page): Promise<void> {
  if (recordingStarts.has(page) || page.url() !== "about:blank") return;
  // about:blank with content (page.setContent) has painted already.
  const empty = await page
    .evaluate(() => (document.body?.childElementCount ?? 0) === 0)
    .catch(() => false);
  if (!empty) return;
  await page.setContent(
    '<!doctype html><title>walkthrough</title><body style="margin:0;background:#9ca3af"></body>',
  );
  recordingStarts.set(page, Date.now());
}

interface PageState {
  /** The screen last held for the viewer. */
  signature: string | null;
  /** An action is running: one it calls itself (clear → fill) runs as is. */
  acting: boolean;
  clip: number;
}

const pages = new WeakMap<Page, PageState>();
const clipCounters = new WeakMap<TestInfo, number>();
const closeTimes = new WeakMap<TestInfo, Record<number, number>>();

/**
 * In the page: a string that changes exactly when the viewer would see a new
 * screen — the document and URL, visible dialogs / overlays and their size,
 * the number of table rows, and the headings. Typing a character changes none
 * of these; a route, a dialog, a dropdown or a row added does. Toasts are not
 * screens. Null when the page cannot answer (closed, mid-navigation).
 */
export async function screenSignature(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const w = window as unknown as { __walkthroughDoc?: string };
      w.__walkthroughDoc ??= Math.random().toString(36).slice(2);
      const parts = [w.__walkthroughDoc, location.href];
      const overlays = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], dialog[open]',
      );
      for (const el of Array.from(overlays)) {
        if (el.checkVisibility()) parts.push(`overlay:${el.getElementsByTagName("*").length}`);
      }
      parts.push(`rows:${document.querySelectorAll("tr").length}`);
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .filter((h) => !h.closest(".p-toast"))
        .map((h) => h.textContent?.trim() ?? "");
      parts.push(`h:${headings.join("/")}`);
      return parts.join("|");
    })
    .catch(() => null);
}

async function hold(page: Page): Promise<void> {
  // A closed page (the step's own failure) has nothing to show; a hold must
  // never replace the step's real result.
  await page.waitForTimeout(WALKTHROUGH_HOLD_MS).catch(() => undefined);
}

/** Before an action: hold any screen the recording has not held yet. */
export async function holdIfNewScreen(page: Page): Promise<void> {
  const state = pages.get(page);
  if (!state) return;
  // Re-sampled after each hold: a screen that lands DURING a hold gets its own.
  for (let i = 0; i < WALKTHROUGH_MAX_HOLDS; i++) {
    const signature = await screenSignature(page);
    if (signature === null || signature === state.signature) return;
    state.signature = signature;
    await hold(page);
  }
}

/** End of a step: always hold, and remember the screen as held. */
export async function holdStepEnd(page: Page): Promise<void> {
  const state = pages.get(page);
  if (!state) return;
  state.signature = await screenSignature(page);
  await hold(page);
}

/** Locator methods that drive the UI; each holds a new screen first. */
const LOCATOR_ACTIONS = [
  "check",
  "clear",
  "click",
  "dblclick",
  "fill",
  "press",
  "pressSequentially",
  "selectOption",
  "setChecked",
  "tap",
  "uncheck",
] as const;
/** Page methods that drive the UI or load a document. */
const PAGE_ACTIONS = ["click", "fill", "goBack", "goForward", "goto", "press", "reload"] as const;

async function paced(
  page: Page,
  target: Locator | null,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const state = pages.get(page);
  if (!state || state.acting) return run();
  if (target) {
    // Wait for the action's own target first, so a screen still arriving is
    // sampled — and held — before the action, not missed.
    await target
      .waitFor({ state: "attached", timeout: WALKTHROUGH_TARGET_WAIT_MS })
      .catch(() => undefined);
  }
  await holdIfNewScreen(page);
  state.acting = true;
  try {
    return await run();
  } finally {
    state.acting = false;
  }
}

let wrapped = false;

/**
 * Route every UI action on a registered page through `paced`. Playwright has no
 * before-action hook, so the Locator and Page prototypes are wrapped once per
 * worker. `fill` on a registered page types per character instead.
 */
function wrapActionsOnce(page: Page): void {
  if (wrapped) return;
  wrapped = true;
  const locatorProto = Object.getPrototypeOf(page.locator("body")) as Record<string, unknown>;
  for (const name of LOCATOR_ACTIONS) {
    const original = locatorProto[name] as (...a: unknown[]) => Promise<unknown>;
    locatorProto[name] = function (this: Locator, ...args: unknown[]) {
      const self = this;
      const owner = self.page();
      if (name === "fill" && pages.has(owner) && !pages.get(owner)?.acting) {
        // Keep the caller's options (timeout) on both halves of the typing.
        const { timeout } = (args[1] ?? {}) as { timeout?: number };
        const bound = timeout === undefined ? {} : { timeout };
        return paced(owner, self, async () => {
          await self.clear(bound);
          await self.pressSequentially(String(args[0] ?? ""), {
            delay: WALKTHROUGH_TYPE_DELAY_MS,
            ...bound,
          });
        });
      }
      return paced(owner, self, () => original.apply(self, args));
    };
  }
  const pageProto = Object.getPrototypeOf(page) as Record<string, unknown>;
  for (const name of PAGE_ACTIONS) {
    const original = pageProto[name] as (...a: unknown[]) => Promise<unknown>;
    pageProto[name] = function (this: Page, ...args: unknown[]) {
      return paced(this, null, () => original.apply(this, args));
    };
  }
}

/**
 * Register a page for the walkthrough on its first step: pace its actions and
 * note its clip. Throws when the page is not being recorded (its context did
 * not come from {@link newContext}).
 */
export async function registerPage(page: Page, testInfo: TestInfo): Promise<number> {
  const known = pages.get(page);
  if (known) return known.clip;
  const video = page.video();
  if (!video) {
    throw new Error(
      "walkthrough: this page is not being recorded — create its context with newContext() from support/walkthrough.ts",
    );
  }
  await markRecordingStart(page);
  wrapActionsOnce(page);
  const clip = clipCounters.get(testInfo) ?? 0;
  clipCounters.set(testInfo, clip + 1);
  pages.set(page, { signature: await screenSignature(page), acting: false, clip });
  const sidecar = testInfo.outputPath(CLIP_CLOSE_FILE);
  const mark: ClipMark = {
    clip,
    video: await video.path(),
    recordingStartedAt: recordingStarts.get(page) ?? null,
    closeFile: sidecar,
  };
  testInfo.annotations.push({ type: CLIP_MARK_ANNOTATION, description: JSON.stringify(mark) });
  // The recording of a page ends when it closes. That instant, with the file's
  // duration, places the clip's first frame on the wall clock — however long
  // the page ran before its first step (a login, for one).
  const closes = closeTimes.get(testInfo) ?? {};
  closeTimes.set(testInfo, closes);
  page.once("close", () => {
    closes[clip] = Date.now();
    writeFileSync(sidecar, JSON.stringify(closes));
  });
  return clip;
}

/** Record where a step starts (called by `step` in walkthrough mode). */
export function markStep(testInfo: TestInfo, mark: StepMark): void {
  testInfo.annotations.push({ type: STEP_MARK_ANNOTATION, description: JSON.stringify(mark) });
}
