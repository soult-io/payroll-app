/**
 * Spec 20 (PAY-78) — journey media on the dashboard: the Screens viewer.
 *
 * Pure rendering. The generator (`generate.ts`) validates the evidence bundle
 * and copies its stills into the site; this module only turns the resulting
 * {@link EvidenceIndex} into HTML.
 *
 * Owner rulings carried here (spec 20):
 * - R4: screens are hidden until requested — a collapsed <details>, and no
 *   image `src` until it opens, so a page of passing journeys makes zero image
 *   requests on load. A FAILED journey opens on its failing step's screen.
 * - R5: provenance or nothing — a card shows a bundle's screens only when the
 *   bundle came from the very run (and commit) the card's result came from.
 *   A step with no still says so; it never borrows a neighbour's image.
 * - R1/R4 (PR 7): the Video tab plays ONLY the human-pace walkthrough, and only
 *   one recorded from the same commit as that gating run, re-running it, with
 *   the same steps. Otherwise there is no Video tab. A passed card with a video
 *   opens on Video; a failed card opens on the failing step's screen.
 */

import type { Source, TestStatus } from "@payroll/verify-summary";
import { escapeHtml } from "./escape.js";

/** One step's still, as served by the site. */
export interface ServedStill {
  /** Site-relative href, already URI-encoded per segment. */
  href: string;
  width: number;
  height: number;
  truncated: boolean;
}

export interface ServedStep {
  title: string;
  status: "passed" | "failed";
  /** null = no still for this step (none captured, or refused at validation). */
  still: ServedStill | null;
}

export interface ServedJourney {
  /** The attempt the steps came from (the final one). */
  attempt: number;
  steps: ServedStep[];
}

/** A validated, copied evidence bundle, keyed by the summary's `fullName`. */
export interface EvidenceIndex {
  runId: string;
  commitSha: string;
  journeys: Map<string, ServedJourney>;
}

/** One journey's walkthrough video, as served by the site. */
export interface ServedWalkthrough {
  href: string;
  durationMs: number;
  /** Per step, in order: its title and its start in the video (ms). */
  steps: { title: string; offsetMs: number | null }[];
}

/** A validated, copied walkthrough bundle, keyed by the summary's `fullName`. */
export interface WalkthroughIndex {
  /** The tested commit it re-recorded. */
  commitSha: string;
  /** The ci run whose gating result it re-recorded. */
  gatingRunId: string;
  /** The walkthrough's own run. */
  runId: string;
  journeys: Map<string, ServedWalkthrough>;
}

/** A walkthrough bound to one card: its video and a start per gating step. */
export interface BoundVideo {
  href: string;
  runId: string;
  offsetsMs: (number | null)[];
}

/** The run a journey card's result came from. */
export interface ResultRun {
  source: Source;
  runId: string;
  gitSha: string;
}

/**
 * The bundle's journey for this card, but only when the bundle is bound to
 * the same run AND commit the card's result came from (R5).
 */
export function evidenceFor(
  evidence: EvidenceIndex | undefined,
  run: ResultRun,
  fullName: string,
): ServedJourney | undefined {
  if (!evidence || run.source !== "ci") return undefined;
  if (evidence.runId !== run.runId || evidence.commitSha !== run.gitSha) return undefined;
  return evidence.journeys.get(fullName);
}

/**
 * The walkthrough for a card whose screens came from `evidence`, only when it
 * re-recorded that very gating run: same commit, gating run id equal to the
 * evidence's run, and the same steps in the same order. Anything else would
 * put a video beside a result it does not show — so no Video tab at all.
 */
export function walkthroughFor(
  walkthrough: WalkthroughIndex | undefined,
  evidence: EvidenceIndex,
  fullName: string,
  journey: ServedJourney,
): BoundVideo | undefined {
  if (!walkthrough) return undefined;
  if (walkthrough.commitSha !== evidence.commitSha) return undefined;
  if (walkthrough.gatingRunId !== evidence.runId) return undefined;
  const video = walkthrough.journeys.get(fullName);
  if (!video || video.steps.length !== journey.steps.length) return undefined;
  if (video.steps.some((s, i) => s.title !== journey.steps[i]?.title)) return undefined;
  return {
    href: video.href,
    runId: walkthrough.runId,
    offsetsMs: video.steps.map((s) => s.offsetMs),
  };
}

/** Index of the step a failed card opens on: the first failed step, else the last. */
export function openingStep(journey: ServedJourney): number {
  const failed = journey.steps.findIndex((s) => s.status === "failed");
  return failed >= 0 ? failed : Math.max(0, journey.steps.length - 1);
}

/** The line a card shows when it has no screens to offer. */
export function noMediaNote(run: ResultRun): string {
  const why =
    run.source === "ci"
      ? "No evidence for this run."
      : "No screens — captured on CI runs only, never the nightly.";
  return `<p class="muted small media-none">${why}</p>`;
}

function stepItem(step: ServedStep, index: number, offsetMs: number | null): string {
  const still = step.still;
  const seek = offsetMs === null ? "" : ` data-t="${(offsetMs / 1000).toFixed(3)}"`;
  const data = still
    ? ` data-src="${escapeHtml(still.href)}" data-w="${still.width}" data-h="${still.height}" data-trunc="${still.truncated ? "1" : "0"}"`
    : ` data-src=""`;
  // The raw link is the no-JS path, and "open full size" with JS.
  const raw = still
    ? ` <a class="raw" href="${escapeHtml(still.href)}" target="_blank" rel="noopener">Screen ↗</a>`
    : ` <span class="muted">no screen</span>`;
  return `<li><button type="button" class="step-btn ${step.status === "failed" ? "fail" : ""}" data-i="${index}" data-title="${escapeHtml(step.title)}"${data}${seek}>${index + 1}. ${escapeHtml(step.title)}</button>${raw}</li>`;
}

/**
 * The media viewer for one journey card: a step list driving one slot with a
 * Video view (the walkthrough, when bound) and a Screens view (the stills).
 *
 * Opens (R4): a FAILED card on Screens at its failing step; a passed card with
 * a video on Video; any other card stays collapsed until asked, on Screens.
 * The video has preload="none" and no src until its view is shown, so a page
 * load fetches no media except the one failing screen per failed card.
 */
export function mediaViewer(
  journey: ServedJourney,
  status: TestStatus,
  runId: string,
  video: BoundVideo | undefined,
  runUrlBase: string | undefined,
): string {
  if (journey.steps.length === 0) {
    return `<p class="muted small media-none">No steps recorded for this journey.</p>`;
  }
  const failed = status === "failed";
  const view = failed || !video ? "screens" : "video";
  const open = failed || video !== undefined;
  const initial = failed ? openingStep(journey) : 0;
  const captured = journey.steps.filter((s) => s.still).length;
  const attempt = journey.attempt > 1 ? ` · from attempt ${journey.attempt}` : "";
  const n = journey.steps.length;
  const runRef = (id: string): string =>
    runUrlBase
      ? `<a href="${escapeHtml(runUrlBase + encodeURIComponent(id))}" target="_blank" rel="noopener">#${escapeHtml(id)}</a>`
      : `#${escapeHtml(id)}`;
  const videoProv = video
    ? ` · walkthrough · run ${runRef(video.runId)} (a separate human-pace recording of this commit) · <a class="raw" href="${escapeHtml(video.href)}" target="_blank" rel="noopener">video ↗</a>`
    : "";
  const tabs = video
    ? `<div class="tabs" role="tablist" aria-label="Media">
          <button type="button" role="tab" class="tab" data-view="video" aria-selected="${view === "video"}">Video</button>
          <button type="button" role="tab" class="tab" data-view="screens" aria-selected="${view === "screens"}">Screens</button>
        </div>`
    : "";
  const vstage = video
    ? `<figure class="vstage">
            <video controls muted playsinline preload="none" width="1280" height="720" data-src="${escapeHtml(video.href)}"></video>
          </figure>`
    : "";
  return `<details class="screens" data-initial="${initial}" data-view="${view}"${open ? " open" : ""}>
        <summary>${video ? "Video · " : ""}Screens · ${n} step${n === 1 ? "" : "s"}${failed ? " · opened on the failing step" : ""}</summary>
        <p class="muted small">stills · chromium · ci run ${escapeHtml(runId)}${attempt} · ${captured}/${n} captured${videoProv}</p>
        ${tabs}
        <div class="viewer">
          <ol class="steplist">${journey.steps.map((s, i) => stepItem(s, i, video?.offsetsMs[i] ?? null)).join("")}</ol>
          <div class="slot">
          ${vstage}
          <figure class="stage">
            <div class="stage-scroll" tabindex="0"><img alt="" hidden></div>
            <p class="none muted" hidden>No screen captured for this step.</p>
            <figcaption>
              <button type="button" class="prev">‹ Prev</button>
              <span class="where"></span>
              <button type="button" class="next">Next ›</button>
              <a class="full" target="_blank" rel="noopener" hidden>open full size ↗</a>
            </figcaption>
          </figure>
          </div>
        </div>
      </details>`;
}

/**
 * The viewer's behaviour, inlined once per page. Reads only data attributes
 * the renderer escaped, and writes via properties / textContent — never HTML.
 */
export const SCREENS_SCRIPT = `
document.documentElement.classList.add("js");
for (const d of document.querySelectorAll("details.screens")) {
  const btns = [...d.querySelectorAll(".step-btn")];
  const img = d.querySelector(".stage img");
  const none = d.querySelector(".stage .none");
  const full = d.querySelector(".stage .full");
  const where = d.querySelector(".stage .where");
  const video = d.querySelector(".vstage video");
  const tabs = [...d.querySelectorAll(".tab")];
  let cur = Number(d.dataset.initial || 0);
  const mark = () => btns.forEach((b, j) => b.setAttribute("aria-current", j === cur ? "step" : "false"));
  const showStill = () => {
    const b = btns[cur];
    const src = b.dataset.src;
    if (src) {
      img.src = src;
      img.width = Number(b.dataset.w);
      img.height = Number(b.dataset.h);
      img.alt = "Screen at the end of step " + (cur + 1) + ": " + b.dataset.title;
      img.hidden = false;
      none.hidden = true;
      full.href = src;
      full.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      none.hidden = false;
      full.hidden = true;
    }
    where.textContent = "Step " + (cur + 1) + " of " + btns.length +
      (src ? " · " + b.dataset.w + "×" + b.dataset.h : "") +
      (b.dataset.trunc === "1" ? " · truncated at capture limit" : "");
  };
  // The video gets its src only when its view is shown; preload="none" means
  // even then nothing is fetched until it plays or seeks.
  const armVideo = () => { if (video && !video.getAttribute("src")) video.src = video.dataset.src; };
  const seek = () => {
    const t = btns[cur].dataset.t;
    if (!video || t === undefined) return;
    armVideo();
    const go = () => { video.currentTime = Number(t); };
    if (video.readyState >= 1) { go(); return; }
    // preload="none" loads nothing on its own: a seek asked for before any
    // metadata loads just enough of THIS video to seek (still no autoplay).
    video.addEventListener("loadedmetadata", go, { once: true });
    video.preload = "metadata";
    video.load();
  };
  const setView = (view) => {
    d.dataset.view = view;
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
    if (view === "video") { if (video && !video.paused) return; seek(); } else { if (video) video.pause(); showStill(); }
  };
  const show = (i) => {
    cur = Math.max(0, Math.min(btns.length - 1, i));
    mark();
    if (d.dataset.view === "video") seek(); else showStill();
  };
  if (video) {
    // The step list follows playback: the current step is the last one started.
    video.addEventListener("timeupdate", () => {
      let at = 0;
      btns.forEach((b, j) => { const t = b.dataset.t; if (t !== undefined && Number(t) <= video.currentTime + 0.05) at = j; });
      if (at !== cur) { cur = at; mark(); }
    });
  }
  tabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  d.addEventListener("toggle", () => { if (d.open) { mark(); if (d.dataset.view === "video") armVideo(); else showStill(); } });
  btns.forEach((b, j) => b.addEventListener("click", () => show(j)));
  d.querySelector(".prev").addEventListener("click", () => show(cur - 1));
  d.querySelector(".next").addEventListener("click", () => show(cur + 1));
  if (d.open) { mark(); if (d.dataset.view === "video") armVideo(); else showStill(); }
}
`;

export const SCREENS_STYLE = `
.tcard:has(> details.screens[open]) { grid-column: 1 / -1; }
details.screens { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
details.screens > summary { cursor: pointer; font-size: 0.86rem; font-weight: 600; }
.viewer { display: grid; gap: 12px; margin-top: 8px; }
@media (min-width: 720px) { .viewer { grid-template-columns: minmax(200px, 1fr) 2fr; } }
.steplist { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }
.steplist li { display: flex; justify-content: space-between; gap: 8px; align-items: baseline;
  padding: 4px 0; border-top: 1px solid var(--border); }
.steplist li:first-child { border-top: 0; }
.step-btn { all: unset; cursor: pointer; color: var(--ink); overflow-wrap: anywhere; }
.step-btn.fail { color: var(--fail); }
.step-btn[aria-current="step"] { font-weight: 700; text-decoration: underline; }
.step-btn:focus-visible { outline: 2px solid var(--pass); outline-offset: 2px; }
.raw, .full { color: var(--pass); white-space: nowrap; font-size: 0.8rem; }
details.screens a { color: var(--pass); }
.slot { min-width: 0; }
.stage, .vstage { display: none; margin: 0; min-width: 0; }
.js details.screens[data-view="screens"] .stage { display: block; }
.js details.screens[data-view="video"] .vstage { display: block; }
.vstage video { display: block; width: 100%; height: auto; border-radius: 8px; background: #000; }
.tabs { display: none; gap: 4px; margin: 8px 0 0; }
.js .tabs { display: flex; }
.tab { font: inherit; font-size: 0.82rem; color: var(--muted); background: none; border: 1px solid var(--border);
  border-radius: 999px; padding: 3px 12px; cursor: pointer; }
.tab[aria-selected="true"] { color: var(--ink); background: var(--border); font-weight: 600; }
.stage-scroll { max-height: 70vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.stage img { display: block; width: 100%; height: auto; }
.stage .none { padding: 24px 12px; margin: 0; border: 1px dashed var(--border); border-radius: 8px; }
.stage figcaption { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; font-size: 0.8rem; color: var(--muted); }
.stage figcaption button { font: inherit; color: var(--ink); background: var(--border); border: 0; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.media-none { font-style: italic; }
`;
