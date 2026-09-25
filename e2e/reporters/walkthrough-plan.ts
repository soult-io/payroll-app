/**
 * Spec 20 (PAY-78) — how a journey's walkthrough clips become one video.
 *
 * Pure: no ffmpeg, no filesystem. The walkthrough reporter measures each clip
 * (duration, and the instant its page closed) and runs the plan this module
 * returns.
 *
 * A journey may drive several pages (admin, employee), each recorded as its own
 * clip. The joined video is, in the order the journey first used each page:
 *
 *   [title card] clip 0 (from its first step) [caption] clip 1 (…) …
 *
 * Each clip is cut to start at its first step: what a page showed before that
 * (a blank first frame, a login done as setup) is not paced and not part of any
 * step, so it would flash by. A caption card before every clip after the first
 * names the step it opens with, so a switch of session is never a jump cut.
 */

/** One recorded page, measured. */
export interface MeasuredClip {
  clip: number;
  video: string;
  /** The step the clip opens with (its caption). */
  firstStep: string;
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
  const used = [...new Set(steps.map((s) => s.clip))];
  if (used.length === 0) return undefined;
  const firstStart = new Map<number, number>();
  for (const s of steps) {
    const prev = firstStart.get(s.clip);
    if (prev === undefined || s.startedAt < prev) firstStart.set(s.clip, s.startedAt);
  }
  // Clips in the order the journey first used them.
  used.sort((a, b) => (firstStart.get(a) ?? 0) - (firstStart.get(b) ?? 0));

  const segments: Segment[] = [{ kind: "card", text: journeyTitle, durationMs: CARD_MS }];
  const offsets = new Map<number, number | null>();
  let at = CARD_MS;
  for (const [i, id] of used.entries()) {
    const clip = byClip.get(id);
    if (!clip || !(clip.durationMs > 0) || !(clip.closedAt > 0)) return undefined;
    if (i > 0) {
      segments.push({ kind: "card", text: `Next: ${clip.firstStep}`, durationMs: CARD_MS });
      at += CARD_MS;
    }
    // The recording's first frame on the wall clock, then the cut to step one.
    const recordedFrom = clip.closedAt - clip.durationMs;
    const fromMs = clamp((firstStart.get(id) ?? recordedFrom) - recordedFrom, 0, clip.durationMs);
    const length = clip.durationMs - fromMs;
    segments.push({ kind: "clip", video: clip.video, fromMs, durationMs: length });
    for (const s of steps.filter((st) => st.clip === id)) {
      const within = s.startedAt - recordedFrom - fromMs;
      offsets.set(s.index, within >= 0 && within <= length ? at + within : null);
    }
    at += length;
  }
  return { segments, offsets, durationMs: at };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
