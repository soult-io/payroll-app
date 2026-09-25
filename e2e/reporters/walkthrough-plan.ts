/**
 * Spec 20 (PAY-78) — how a journey's walkthrough clips become one video.
 *
 * Pure: no ffmpeg, no filesystem. The walkthrough reporter measures each clip
 * (duration, and the instant its page closed) and runs the plan this module
 * returns.
 *
 * A journey may drive several pages (admin, employee), each recorded as its own
 * clip, and may switch back and forth between them. The joined video follows
 * the STEPS, in the order they ran (spec 20 D3):
 *
 *   [title card] run 1 [caption] run 2 [caption] run 3 …
 *
 * where a "run" is an unbroken stretch of steps on one page. Each run is cut
 * from its clip: from its first step's start to the moment the next run starts
 * (the page sat idle after that), or to the clip's end for the journey's last
 * run. A caption card names the step each later run opens with, so a switch of
 * session is never a jump cut. What a page showed before its first step (a
 * blank first frame, a login done as setup) is left out: it is not paced and
 * belongs to no step.
 */

/** One recorded page, measured. */
export interface MeasuredClip {
  clip: number;
  video: string;
  /** Length of the recorded file (ms). */
  durationMs: number;
  /** Wall-clock instant the page closed, which is when its recording ended. */
  closedAt: number;
}

/** Where a step started: which clip, and the wall-clock instant. */
export interface StepStart {
  index: number;
  title: string;
  clip: number;
  startedAt: number;
}

export type Segment =
  | { kind: "card"; text: string; durationMs: number }
  | { kind: "clip"; video: string; fromMs: number; durationMs: number };

export interface StitchPlan {
  segments: Segment[];
  /** Per step index: its start in the joined video (ms); null when unplaceable. */
  offsets: Map<number, number | null>;
  durationMs: number;
}

/** How long a title or caption card stays up (ms) — the same as a screen hold. */
export const CARD_MS = 1500;

/** Consecutive steps on one clip, in the order they ran. */
function runsOf(steps: readonly StepStart[]): StepStart[][] {
  const ordered = [...steps].sort((a, b) => a.startedAt - b.startedAt || a.index - b.index);
  const runs: StepStart[][] = [];
  for (const s of ordered) {
    const last = runs.at(-1);
    if (last && last[0]?.clip === s.clip) last.push(s);
    else runs.push([s]);
  }
  return runs;
}

function usable(clip: MeasuredClip | undefined): clip is MeasuredClip {
  return clip !== undefined && clip.durationMs > 0 && clip.closedAt > 0;
}

/**
 * Cut one run from its clip: from its first step to the start of the next run
 * (the page sat idle after that), or to the clip's end. Offsets are within the
 * cut.
 */
function cutRun(
  run: StepStart[],
  clip: MeasuredClip,
  nextStart: number | undefined,
): { segment: Segment & { kind: "clip" }; within: Map<number, number | null> } {
  // The recording's first frame on the wall clock.
  const recordedFrom = clip.closedAt - clip.durationMs;
  const fromMs = clamp((run[0]?.startedAt ?? recordedFrom) - recordedFrom, 0, clip.durationMs);
  const toMs =
    nextStart === undefined
      ? clip.durationMs
      : clamp(nextStart - recordedFrom, fromMs, clip.durationMs);
  const length = toMs - fromMs;
  const within = new Map<number, number | null>();
  for (const s of run) {
    // A step that began before its clip's first frame (a page's first paint
    // comes after the step's navigation starts) is shown from the cut's start.
    const t = s.startedAt - recordedFrom - fromMs;
    within.set(s.index, t <= length ? Math.max(0, t) : null);
  }
  return { segment: { kind: "clip", video: clip.video, fromMs, durationMs: length }, within };
}

/**
 * Plan the joined video. `undefined` when a clip the steps use was not measured
 * (no close instant or no duration): no video is better than a wrong one.
 */
export function planStitch(
  journeyTitle: string,
  clips: readonly MeasuredClip[],
  steps: readonly StepStart[],
): StitchPlan | undefined {
  const byClip = new Map(clips.map((c) => [c.clip, c]));
  const runs = runsOf(steps);
  if (runs.length === 0) return undefined;
  if (!runs.every((run) => usable(byClip.get(run[0]?.clip ?? -1)))) return undefined;

  const segments: Segment[] = [{ kind: "card", text: journeyTitle, durationMs: CARD_MS }];
  const offsets = new Map<number, number | null>();
  let at = CARD_MS;
  for (const [i, run] of runs.entries()) {
    const clip = byClip.get(run[0]?.clip ?? -1) as MeasuredClip;
    if (i > 0) {
      segments.push({ kind: "card", text: `Next: ${run[0]?.title ?? ""}`, durationMs: CARD_MS });
      at += CARD_MS;
    }
    const { segment, within } = cutRun(run, clip, runs[i + 1]?.[0]?.startedAt);
    segments.push(segment);
    for (const [index, t] of within) offsets.set(index, t === null ? null : at + t);
    at += segment.durationMs;
  }
  return { segments, offsets, durationMs: at };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
