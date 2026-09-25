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
 */

import type { Source, TestStatus } from "@payroll/verify-summary";

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

/** The run a journey card's result came from. */
export interface ResultRun {
  source: Source;
  runId: string;
  gitSha: string;
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function stepItem(step: ServedStep, index: number): string {
  const still = step.still;
  const data = still
    ? ` data-src="${escapeAttr(still.href)}" data-w="${still.width}" data-h="${still.height}" data-trunc="${still.truncated ? "1" : "0"}"`
    : ` data-src=""`;
  // The raw link is the no-JS path, and "open full size" with JS.
  const raw = still
    ? ` <a class="raw" href="${escapeAttr(still.href)}" target="_blank" rel="noopener">Screen ↗</a>`
    : ` <span class="muted">no screen</span>`;
  return `<li><button type="button" class="step-btn ${step.status === "failed" ? "fail" : ""}" data-i="${index}" data-title="${escapeAttr(step.title)}"${data}>${index + 1}. ${escapeAttr(step.title)}</button>${raw}</li>`;
}

/**
 * The Screens viewer for one journey card. `status` is the card's shown
 * status: a failed card opens on its failing step, everything else stays
 * collapsed until asked (R4).
 */
export function screensViewer(journey: ServedJourney, status: TestStatus, runId: string): string {
  if (journey.steps.length === 0) {
    return `<p class="muted small media-none">No steps recorded for this journey.</p>`;
  }
  const failed = status === "failed";
  const initial = failed ? openingStep(journey) : 0;
  const captured = journey.steps.filter((s) => s.still).length;
  const attempt = journey.attempt > 1 ? ` · from attempt ${journey.attempt}` : "";
  return `<details class="screens" data-initial="${initial}"${failed ? " open" : ""}>
        <summary>Screens · ${journey.steps.length} step${journey.steps.length === 1 ? "" : "s"}${failed ? " · opened on the failing step" : ""}</summary>
        <p class="muted small">stills · chromium · ci run ${escapeAttr(runId)}${attempt} · ${captured}/${journey.steps.length} captured</p>
        <div class="viewer">
          <ol class="steplist">${journey.steps.map(stepItem).join("")}</ol>
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
  let cur = Number(d.dataset.initial || 0);
  const show = (i) => {
    cur = Math.max(0, Math.min(btns.length - 1, i));
    btns.forEach((b, j) => b.setAttribute("aria-current", j === cur ? "step" : "false"));
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
  d.addEventListener("toggle", () => { if (d.open) show(cur); });
  btns.forEach((b, j) => b.addEventListener("click", () => show(j)));
  d.querySelector(".prev").addEventListener("click", () => show(cur - 1));
  d.querySelector(".next").addEventListener("click", () => show(cur + 1));
  if (d.open) show(cur);
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
.stage { display: none; margin: 0; min-width: 0; }
.js .stage { display: block; }
.stage-scroll { max-height: 70vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.stage img { display: block; width: 100%; height: auto; }
.stage .none { padding: 24px 12px; margin: 0; border: 1px dashed var(--border); border-radius: 8px; }
.stage figcaption { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; font-size: 0.8rem; color: var(--muted); }
.stage figcaption button { font: inherit; color: var(--ink); background: var(--border); border: 0; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.media-none { font-style: italic; }
`;
