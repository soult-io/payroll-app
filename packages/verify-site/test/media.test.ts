import type { TestResult, VerifySummary } from "@payroll/verify-summary";
import { describe, expect, it } from "vitest";
import { isHarnessTest, renderPage } from "../src/lib.js";
import { type EvidenceIndex, evidenceFor, openingStep, type ServedJourney } from "../src/media.js";

const SHA = "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7";
const NOW = new Date("2026-09-25T10:00:00Z");

function e2eTest(name: string, status: TestResult["status"], extra: Partial<TestResult> = {}) {
  return {
    name,
    fullName: `journeys.spec.ts ${name}`,
    status,
    durationMs: 1000,
    file: "journeys.spec.ts",
    ...extra,
  };
}

function ciSummary(tests: TestResult[], over: Partial<VerifySummary> = {}): VerifySummary {
  const failed = tests.filter((t) => t.status === "failed").length;
  const passed = tests.filter((t) => t.status === "passed").length;
  return {
    schemaVersion: 2,
    runId: "42",
    source: "ci",
    gitSha: SHA,
    gitRef: "refs/heads/main",
    generatedAt: "2026-09-25T09:00:00Z",
    overallStatus: failed > 0 ? "failed" : "passed",
    counts: { passed, failed, skipped: 0, executed: tests.length, total: tests.length },
    suites: [
      {
        key: "e2e",
        name: "Playwright journeys",
        status: failed > 0 ? "failed" : "passed",
        durationMs: 1000,
        counts: { passed, failed, skipped: 0, executed: tests.length, total: tests.length },
        tests,
      },
    ],
    ...over,
  };
}

function journey(steps: ServedJourney["steps"], attempt = 1): ServedJourney {
  return { attempt, steps };
}

const still = (n: number) => ({
  href: `media/ci/j/step-still-${n}.jpg`,
  width: 1280,
  height: 900 + n,
  truncated: false,
});

function index(
  entries: [string, ServedJourney][],
  over: Partial<EvidenceIndex> = {},
): EvidenceIndex {
  return { runId: "42", commitSha: SHA, journeys: new Map(entries), ...over };
}

function cardFor(html: string, name: string): string {
  const start = html.indexOf(`<h3>${name}</h3>`);
  expect(start).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<article", start);
  return html.slice(open, html.indexOf("</article>", start));
}

describe("evidenceFor (R5: same run, same commit)", () => {
  const ev = index([["journeys.spec.ts j", journey([])]]);
  it("binds a ci result from the bundle's run and commit", () => {
    expect(
      evidenceFor(ev, { source: "ci", runId: "42", gitSha: SHA }, "journeys.spec.ts j"),
    ).toBeDefined();
  });
  it("refuses another run", () => {
    expect(
      evidenceFor(ev, { source: "ci", runId: "41", gitSha: SHA }, "journeys.spec.ts j"),
    ).toBeUndefined();
  });
  it("refuses another commit under the same run id", () => {
    expect(
      evidenceFor(ev, { source: "ci", runId: "42", gitSha: "f".repeat(40) }, "journeys.spec.ts j"),
    ).toBeUndefined();
  });
  it("refuses a nightly result (spec 20 D2)", () => {
    expect(
      evidenceFor(ev, { source: "nightly", runId: "42", gitSha: SHA }, "journeys.spec.ts j"),
    ).toBeUndefined();
  });
});

describe("openingStep", () => {
  it("is the first failed step, else the last", () => {
    expect(
      openingStep(
        journey([
          { title: "a", status: "passed", still: null },
          { title: "b", status: "failed", still: null },
          { title: "c", status: "failed", still: null },
        ]),
      ),
    ).toBe(1);
    expect(
      openingStep(
        journey([
          { title: "a", status: "passed", still: null },
          { title: "b", status: "passed", still: null },
        ]),
      ),
    ).toBe(1);
  });
});

describe("journey card screens", () => {
  it("a passing journey's screens start collapsed, with no image src (zero requests on load)", () => {
    const t = e2eTest("journey 1", "passed");
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([
        [t.fullName, journey([{ title: "Sign in", status: "passed", still: still(1) }])],
      ]),
    });
    const card = cardFor(html, "journey 1");
    expect(card).toContain('<details class="screens" data-initial="0">');
    expect(card).toContain('data-src="media/ci/j/step-still-1.jpg"');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/i);
    // No-JS path: a plain link per captured step.
    expect(card).toContain('href="media/ci/j/step-still-1.jpg"');
  });

  it("a failed journey opens on its failing step", () => {
    const t = e2eTest("journey 2", "failed");
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([
        [
          t.fullName,
          journey([
            { title: "Open run", status: "passed", still: still(1) },
            { title: "Approve", status: "failed", still: still(2) },
          ]),
        ],
      ]),
    });
    const card = cardFor(html, "journey 2");
    expect(card).toContain('<details class="screens" data-initial="1" open>');
    expect(card).toContain("opened on the failing step");
  });

  it("a step with no still says so, and carries no image of another step", () => {
    const t = e2eTest("journey 3", "passed");
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([
        [
          t.fullName,
          journey([
            { title: "First", status: "passed", still: still(1) },
            { title: "Second", status: "passed", still: null },
          ]),
        ],
      ]),
    });
    const card = cardFor(html, "journey 3");
    expect(card).toMatch(/data-i="1" data-title="Second" data-src=""/);
    expect(card).toContain("no screen");
    expect(card).toContain("1/2 captured");
  });

  it("a flaky journey keeps its FLAKY chip and names the attempt the screens came from", () => {
    const t = e2eTest("journey 4", "flaky", { attempts: 2 });
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([
        [t.fullName, journey([{ title: "x", status: "passed", still: still(1) }], 2)],
      ]),
    });
    const card = cardFor(html, "journey 4");
    expect(card).toContain("FLAKY");
    expect(card).toContain("from attempt 2");
  });

  it("a ci result from a run with no matching bundle says 'No evidence for this run'", () => {
    const t = e2eTest("journey 5", "passed");
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([[t.fullName, journey([])]], { runId: "41" }),
    });
    const card = cardFor(html, "journey 5");
    expect(card).toContain("No evidence for this run.");
    expect(card).not.toContain("details");
  });

  it("with no bundle at all, a ci card still says so rather than staying silent", () => {
    const t = e2eTest("journey 6", "passed");
    const html = renderPage([ciSummary([t])], { now: NOW });
    expect(cardFor(html, "journey 6")).toContain("No evidence for this run.");
  });

  it("a nightly-sourced card never shows screens", () => {
    const t = e2eTest("journey 7", "passed");
    const html = renderPage([ciSummary([t], { source: "nightly" })], {
      now: NOW,
      evidence: index([[t.fullName, journey([{ title: "x", status: "passed", still: still(1) }])]]),
    });
    const card = cardFor(html, "journey 7");
    expect(card).toContain("captured on CI runs only");
    expect(card).not.toContain("data-src");
  });

  it("escapes step titles and hrefs", () => {
    const t = e2eTest("journey 8", "passed");
    const html = renderPage([ciSummary([t])], {
      now: NOW,
      evidence: index([
        [
          t.fullName,
          journey([
            {
              title: `<img src=x onerror="alert(1)">`,
              status: "passed",
              still: { ...still(1), href: `media/ci/"><script>` },
            },
          ]),
        ],
      ]),
    });
    const card = cardFor(html, "journey 8");
    expect(card).not.toContain("<img src=x");
    expect(card).not.toContain('"><script>');
  });

  it("the viewer script is inlined once and writes no HTML", () => {
    const html = renderPage([ciSummary([e2eTest("j", "passed")])], { now: NOW });
    // Plain substring count: the page is our own output, not filtered input.
    expect(html.split("<script>").length - 1).toBe(1);
    expect(html).not.toContain("innerHTML");
  });
});

describe("utility specs", () => {
  it("get a card but no media line (they never carry evidence)", () => {
    const t = e2eTest("login form keeps a gutter", "passed", {
      fullName: "mobile-login.spec.ts login form keeps a gutter",
      file: "mobile-login.spec.ts",
    });
    const card = cardFor(renderPage([ciSummary([t])], { now: NOW }), "login form keeps a gutter");
    expect(card).not.toContain("media-none");
    expect(card).not.toContain("screens");
  });
});

describe("harness tests get no journey card", () => {
  it("isHarnessTest matches the `harness · …` describe", () => {
    expect(
      isHarnessTest(
        e2eTest("x", "passed", {
          fullName: "journey-stills.spec.ts harness · journey stills a short page",
        }),
      ),
    ).toBe(true);
    expect(isHarnessTest(e2eTest("journey 1", "passed"))).toBe(false);
  });

  it("harness tests are left off the journey cards", () => {
    const harness = e2eTest("a short page gives one still", "passed", {
      fullName: "journey-stills.spec.ts harness · journey stills a short page gives one still",
      file: "journey-stills.spec.ts",
    });
    const html = renderPage([ciSummary([e2eTest("journey 1", "passed"), harness])], { now: NOW });
    expect(html).toContain("<h3>journey 1</h3>");
    expect(html).not.toContain("<h3>a short page gives one still</h3>");
  });
});
