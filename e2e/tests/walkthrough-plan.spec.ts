/**
 * Spec 20 (PAY-78): how walkthrough clips are joined — pure planning, no ffmpeg.
 */

import { expect, test } from "@playwright/test";
import { CARD_MS, planStitch, type Segment, videoTimeOf } from "../reporters/walkthrough-plan.js";

// Wall-clock instants in ms. Clip 0 (employee) recorded 10_000..90_000,
// clip 1 (admin) recorded 30_000..70_000.
const emp = { clip: 0, video: "emp.webm", durationMs: 80_000, closedAt: 90_000 };
const admin = { clip: 1, video: "admin.webm", durationMs: 40_000, closedAt: 70_000 };

function shape(segments: Segment[] | undefined): string[] {
  return (segments ?? []).map((s) =>
    s.kind === "card" ? `card:${s.text}` : `clip:${s.video}@${s.fromMs}+${s.durationMs}`,
  );
}

test.describe("harness · walkthrough plan", () => {
  test("one page: title card, then the clip cut at its first step", () => {
    const plan = planStitch(
      "journey 1",
      [emp],
      [
        { index: 0, title: "Sign in", clip: 0, startedAt: 12_000 },
        { index: 1, title: "Open payslip", clip: 0, startedAt: 20_000 },
      ],
    );
    // recorded from 10_000; step one at 12_000 → the first 2s (setup) are cut
    expect(shape(plan?.segments)).toEqual(["card:journey 1", "clip:emp.webm@2000+78000"]);
    expect(plan?.offsets.get(0)).toBe(CARD_MS);
    expect(plan?.offsets.get(1)).toBe(CARD_MS + 8_000);
    expect(plan?.durationMs).toBe(CARD_MS + 78_000);
  });

  test("A → B → A follows the steps: each run cut to its stretch, a caption at every switch", () => {
    // journey 3's shape: employee submits, admin approves, employee sees it.
    const plan = planStitch(
      "journey 3",
      [emp, admin],
      [
        { index: 0, title: "Employee fills in", clip: 0, startedAt: 11_000 },
        { index: 1, title: "Employee submits", clip: 0, startedAt: 20_000 },
        { index: 2, title: "Admin reviews", clip: 1, startedAt: 35_000 },
        { index: 3, title: "Admin approves", clip: 1, startedAt: 45_000 },
        { index: 4, title: "Employee sees Approved", clip: 0, startedAt: 75_000 },
      ],
    );
    expect(shape(plan?.segments)).toEqual([
      "card:journey 3",
      // employee from 11_000 to the admin's first step at 35_000
      "clip:emp.webm@1000+24000",
      "card:Next: Admin reviews",
      // admin from 35_000 (recorded from 30_000) to employee's return at 75_000,
      // capped at the admin clip's end (40_000 long)
      "clip:admin.webm@5000+35000",
      "card:Next: Employee sees Approved",
      // employee again from 75_000 to its end at 90_000
      "clip:emp.webm@65000+15000",
    ]);
    const o = plan?.offsets;
    // Step order is preserved in the video.
    const starts = [0, 1, 2, 3, 4].map((i) => o?.get(i) ?? Number.NaN);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(o?.get(2)).toBe(CARD_MS + 24_000 + CARD_MS);
    expect(o?.get(4)).toBe(CARD_MS + 24_000 + CARD_MS + 35_000 + CARD_MS);
  });

  test("an exact recording start wins over the close-based estimate", () => {
    // Recording really began at 10_600; the close estimate would say 10_000.
    const plan = planStitch(
      "j",
      [{ ...emp, startedAt: 10_600 }],
      [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }],
    );
    expect(shape(plan?.segments)).toEqual(["card:j", "clip:emp.webm@1400+78600"]);
  });

  test("a stamped start with no close time is still usable", () => {
    const plan = planStitch(
      "j",
      [{ ...emp, closedAt: Number.NaN, startedAt: 10_000 }],
      [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }],
    );
    expect(shape(plan?.segments)).toEqual(["card:j", "clip:emp.webm@2000+78000"]);
  });

  test("videoTimeOf maps an action's instant into the joined video, or null when cut", () => {
    const plan = planStitch(
      "journey 3",
      [emp, admin],
      [
        { index: 0, title: "Employee fills in", clip: 0, startedAt: 11_000 },
        { index: 1, title: "Admin reviews", clip: 1, startedAt: 35_000 },
        { index: 2, title: "Employee sees it", clip: 0, startedAt: 75_000 },
      ],
    );
    if (!plan) throw new Error("no plan");
    // employee clicks at 20_000: 9s into the first cut, after the title card
    expect(videoTimeOf(plan, 0, 20_000)).toBe(CARD_MS + 9_000);
    // admin clicks at 40_000: 5s into its cut
    expect(videoTimeOf(plan, 1, 40_000)).toBe(CARD_MS + 24_000 + CARD_MS + 5_000);
    // employee at 50_000 was not on screen (admin was): cut
    expect(videoTimeOf(plan, 0, 50_000)).toBeNull();
    // employee again at 80_000: 5s into the third cut (the admin cut is 35s,
    // capped at the admin clip's end)
    expect(videoTimeOf(plan, 0, 80_000)).toBe(
      CARD_MS + 24_000 + CARD_MS + 35_000 + CARD_MS + 5_000,
    );
  });

  test("a clip that could not be measured gives no plan — never a wrong video", () => {
    const one = [{ index: 0, title: "s", clip: 0, startedAt: 12_000 }];
    expect(planStitch("j", [{ ...emp, durationMs: Number.NaN }], one)).toBeUndefined();
    expect(planStitch("j", [{ ...emp, closedAt: Number.NaN }], one)).toBeUndefined();
    expect(planStitch("j", [], one)).toBeUndefined();
  });

  test("no steps, no plan", () => {
    expect(planStitch("j", [emp], [])).toBeUndefined();
  });

  test("a step that began before its clip's first frame is placed at the cut's start", () => {
    // emp's first frame is at 10_000; the step's navigation began at 9_400.
    const plan = planStitch("j", [emp], [{ index: 0, title: "s", clip: 0, startedAt: 9_400 }]);
    expect(plan?.offsets.get(0)).toBe(CARD_MS);
    expect(shape(plan?.segments)).toEqual(["card:j", "clip:emp.webm@0+80000"]);
  });

  test("a step outside its clip's recording gets no offset rather than a wrong one", () => {
    const plan = planStitch(
      "j",
      [admin],
      [
        { index: 0, title: "s", clip: 1, startedAt: 32_000 },
        { index: 1, title: "after close", clip: 1, startedAt: 80_000 },
      ],
    );
    expect(plan?.offsets.get(1)).toBeNull();
  });
});
