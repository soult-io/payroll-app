/**
 * Spec 20 (PAY-78): how walkthrough clips are joined — pure planning, no ffmpeg.
 */

import { expect, test } from "@playwright/test";
import { CARD_MS, planStitch } from "../reporters/walkthrough-plan.js";

// Wall-clock instants in ms; clip 0 recorded 10_000..40_000, clip 1 50_000..70_000.
const clip0 = {
  clip: 0,
  video: "a.webm",
  firstStep: "Admin signs in",
  durationMs: 30_000,
  closedAt: 40_000,
};
const clip1 = {
  clip: 1,
  video: "b.webm",
  firstStep: "Employee opens the payslip",
  durationMs: 20_000,
  closedAt: 70_000,
};

test.describe("harness · walkthrough plan", () => {
  test("one clip: title card, then the clip cut at its first step", () => {
    const plan = planStitch(
      "journey 1",
      [clip0],
      [
        { index: 0, title: "Admin signs in", clip: 0, startedAt: 12_000 },
        { index: 1, title: "Approve", clip: 0, startedAt: 20_000 },
      ],
    );
    expect(plan?.segments).toEqual([
      { kind: "card", text: "journey 1", durationMs: CARD_MS },
      // recorded from 10_000; step one at 12_000 → cut the first 2s of setup
      { kind: "clip", video: "a.webm", fromMs: 2_000, durationMs: 28_000 },
    ]);
    expect(plan?.offsets.get(0)).toBe(CARD_MS);
    expect(plan?.offsets.get(1)).toBe(CARD_MS + 8_000);
    expect(plan?.durationMs).toBe(CARD_MS + 28_000);
  });

  test("two sessions: a caption card names the step the next clip opens with", () => {
    const plan = planStitch(
      "journey 2",
      [clip1, clip0],
      [
        { index: 0, title: "Admin signs in", clip: 0, startedAt: 11_000 },
        { index: 1, title: "Employee opens the payslip", clip: 1, startedAt: 52_000 },
        { index: 2, title: "PDF downloads", clip: 1, startedAt: 60_000 },
      ],
    );
    expect(
      plan?.segments.map((s) => (s.kind === "card" ? `card:${s.text}` : `clip:${s.video}`)),
    ).toEqual([
      "card:journey 2",
      "clip:a.webm",
      "card:Next: Employee opens the payslip",
      "clip:b.webm",
    ]);
    const firstClip = 30_000 - 1_000; // cut at 11_000, recorded from 10_000
    expect(plan?.offsets.get(1)).toBe(CARD_MS + firstClip + CARD_MS);
    expect(plan?.offsets.get(2)).toBe(CARD_MS + firstClip + CARD_MS + 8_000);
  });

  test("clips follow the order the journey first used them, not their numbering", () => {
    const plan = planStitch(
      "j",
      [clip0, clip1],
      [
        { index: 0, title: "first", clip: 1, startedAt: 51_000 },
        { index: 1, title: "second", clip: 0, startedAt: 35_000 },
      ],
    );
    const clips = plan?.segments
      .filter((s) => s.kind === "clip")
      .map((s) => s.kind === "clip" && s.video);
    expect(clips).toEqual(["a.webm", "b.webm"]);
  });

  test("a clip that could not be measured gives no plan — never a wrong video", () => {
    const unmeasured = { ...clip0, durationMs: Number.NaN };
    expect(
      planStitch("j", [unmeasured], [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }]),
    ).toBeUndefined();
    const unclosed = { ...clip0, closedAt: Number.NaN };
    expect(
      planStitch("j", [unclosed], [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }]),
    ).toBeUndefined();
    expect(
      planStitch("j", [], [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }]),
    ).toBeUndefined();
  });

  test("no steps, no plan", () => {
    expect(planStitch("j", [clip0], [])).toBeUndefined();
  });

  test("a step outside its clip's recording gets no offset rather than a wrong one", () => {
    const plan = planStitch(
      "j",
      [clip0],
      [
        { index: 0, title: "s", clip: 0, startedAt: 12_000 },
        { index: 1, title: "late", clip: 0, startedAt: 45_000 },
      ],
    );
    expect(plan?.offsets.get(1)).toBeNull();
  });
});
