import type { SuiteResult, TestResult, VerifySummary } from "@payroll/verify-summary";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatDurationMs,
  lastExecutedAtByTest,
  lastExecutionOf,
  passRate,
  renderPage,
  shortSha,
  sortByGeneratedAtDesc,
} from "../src/lib.js";

function suite(
  key: SuiteResult["key"],
  name: string,
  passed: number,
  failed: number,
  skipped: number,
): SuiteResult {
  return {
    key,
    name,
    status: failed > 0 ? "failed" : passed === 0 ? "not_run" : "passed",
    durationMs: 1000,
    counts: {
      passed,
      failed,
      skipped,
      executed: passed + failed,
      total: passed + failed + skipped,
    },
    tests: [],
  };
}

function summary(over: Partial<VerifySummary> & { generatedAt: string }): VerifySummary {
  const suites = over.suites ?? [suite("engine", "Engine unit tests", 10, 0, 0)];
  const counts = over.counts ?? { passed: 10, failed: 0, skipped: 0, executed: 10, total: 10 };
  return {
    schemaVersion: 2,
    runId: "r",
    source: "ci",
    gitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    gitRef: "refs/heads/main",
    overallStatus: counts.failed > 0 ? "failed" : "passed",
    counts,
    suites,
    ...over,
  };
}

describe("helpers", () => {
  it("escapeHtml escapes all metacharacters", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("formatDurationMs", () => {
    expect(formatDurationMs(820)).toBe("820ms");
    expect(formatDurationMs(3200)).toBe("3.2s");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("shortSha shortens a hex sha but leaves non-sha alone", () => {
    expect(shortSha("8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7")).toBe("8d80bba");
    expect(shortSha("unknown")).toBe("unknown");
  });

  it("passRate ignores skipped and handles all-skipped", () => {
    expect(
      passRate(
        summary({
          generatedAt: "2026-09-21T00:00:00Z",
          counts: { passed: 3, failed: 1, skipped: 5, executed: 4, total: 9 },
        }),
      ),
    ).toBe(75);
    expect(
      passRate(
        summary({
          generatedAt: "2026-09-21T00:00:00Z",
          counts: { passed: 0, failed: 0, skipped: 4, executed: 0, total: 4 },
        }),
      ),
      // Spec 18: a run that executed nothing has no pass rate. It is not 100%.
    ).toBeUndefined();
  });

  it("sortByGeneratedAtDesc orders newest first without mutating input", () => {
    const a = summary({ generatedAt: "2026-09-20T00:00:00Z" });
    const b = summary({ generatedAt: "2026-09-21T00:00:00Z" });
    const input = [a, b];
    const sorted = sortByGeneratedAtDesc(input);
    expect(sorted.map((s) => s.generatedAt)).toEqual([
      "2026-09-21T00:00:00Z",
      "2026-09-20T00:00:00Z",
    ]);
    expect(input).toEqual([a, b]);
  });
});

describe("renderPage", () => {
  it("renders the empty state with no history", () => {
    const html = renderPage([]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("No verification runs ingested yet");
    expect(html).not.toContain("badge fail");
  });

  it("renders the latest run's status, counts, suites and report link", () => {
    const html = renderPage(
      [
        summary({
          generatedAt: "2026-09-21T05:20:00Z",
          gitSha: "aaaaaaa0000000000000000000000000000000ff",
          counts: { passed: 185, failed: 0, skipped: 6, executed: 185, total: 191 },
          suites: [
            suite("engine", "Engine unit tests", 171, 0, 0),
            suite("e2e", "Playwright journeys", 14, 0, 6),
          ],
        }),
      ],
      { reportHref: "report/" },
    );
    expect(html).toContain(">PASSED<");
    expect(html).toContain("aaaaaaa"); // shortened sha
    expect(html).toContain("185</strong> passed");
    expect(html).toContain("Playwright journeys");
    expect(html).toContain('href="report/"');
  });

  it("shows the newest run in the header when history is unsorted", () => {
    const older = summary({
      generatedAt: "2026-09-19T00:00:00Z",
      gitSha: "0000000older00000000000000000000000000ff",
    });
    const newer = summary({
      generatedAt: "2026-09-21T00:00:00Z",
      gitSha: "1111111newer0000000000000000000000000fff",
    });
    const html = renderPage([older, newer]);
    const headerRegion = html.slice(0, html.indexOf("Recent runs"));
    expect(headerRegion).toContain("1111111"); // newer sha in header card
  });

  it("escapes suite names (no raw HTML injection)", () => {
    const html = renderPage([
      summary({
        generatedAt: "2026-09-21T00:00:00Z",
        suites: [suite("server", "<script>evil</script>", 1, 0, 0)],
      }),
    ]);
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });

  it("marks a failing run FAILED", () => {
    const html = renderPage([
      summary({
        generatedAt: "2026-09-21T00:00:00Z",
        counts: { passed: 5, failed: 2, skipped: 0, executed: 7, total: 7 },
        suites: [suite("server", "Server integration tests", 5, 2, 0)],
      }),
    ]);
    expect(html).toContain(">FAILED<");
    expect(html).toContain("badge fail");
  });

  it("caps the history table at historyLimit rows", () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      summary({ generatedAt: `2026-09-2${i}T00:00:00Z` }),
    );
    const html = renderPage(history, { historyLimit: 2 });
    // one pass-rate bar per history row → exactly historyLimit rows.
    expect(html.match(/class="bar"/g)?.length).toBe(2);
  });

  it("omits the report link when no reportHref is given", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z" })]);
    expect(html).not.toContain("View full test report");
  });

  it("renders the empty-suites fallback", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [] })]);
    expect(html).toContain("no suites reported");
  });

  it("falls back to the raw (escaped) value for an unparseable generatedAt", () => {
    const html = renderPage([summary({ generatedAt: "not-a-date" })]);
    expect(html).toContain("not-a-date");
  });
});

describe("rich cards (chunk C)", () => {
  const e2eSuite: SuiteResult = {
    key: "e2e",
    name: "Playwright journeys",
    status: "passed",
    durationMs: 100,
    counts: { passed: 2, failed: 0, skipped: 0, executed: 2, total: 2 },
    tests: [
      {
        name: "journey 1: onboarding",
        fullName: "j1",
        status: "passed",
        durationMs: 50,
        file: "tests/journeys.spec.ts",
      },
      {
        name: "journey 2: payroll run",
        fullName: "j2",
        status: "passed",
        durationMs: 50,
        file: "tests/journeys.spec.ts",
      },
    ],
  };
  const serverSuite: SuiteResult = {
    key: "server",
    name: "Server integration tests",
    status: "failed",
    durationMs: 30,
    counts: { passed: 2, failed: 1, skipped: 0, executed: 3, total: 3 },
    tests: [
      {
        name: "zero credit -> 6.0% net, $420 per employee",
        fullName: "a",
        status: "passed",
        durationMs: 5,
        file: "/repo/apps/server/test/futa-credit.test.ts",
      },
      {
        name: "fills every computed line",
        fullName: "b",
        status: "failed",
        durationMs: 5,
        file: "/repo/apps/server/test/f941-pdf.test.ts",
      },
      {
        name: "some non-tax test",
        fullName: "c",
        status: "passed",
        durationMs: 5,
        file: "/repo/apps/server/test/auth-flows.test.ts",
      },
    ],
  };

  it("renders per-journey cards from the e2e suite", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [e2eSuite] })]);
    expect(html).toContain("End-to-end journeys");
    expect(html).toContain("journey 1: onboarding");
    expect(html).toContain("journey 2: payroll run");
  });

  it("omits the journeys section when there is no e2e suite", () => {
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [serverSuite] }),
    ]);
    expect(html).not.toContain("End-to-end journeys");
  });

  it("groups tax checks into worksheet cards and marks a failing check FAIL", () => {
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [serverSuite] }),
    ]);
    expect(html).toContain("Tax-worksheet correctness");
    expect(html).toContain("Form 940 / FUTA");
    expect(html).toContain("Form 941");
    expect(html).toContain("zero credit -&gt; 6.0% net, $420 per employee");
    expect(html).not.toContain("some non-tax test"); // non-tax test excluded from cards
    expect(html).toContain(">FAIL<"); // the f941 check badge, distinct from the suite's ">FAILED<"
  });

  it("omits the tax section when no tax-classified tests are present", () => {
    const nonTax: SuiteResult = {
      ...serverSuite,
      tests: [
        {
          name: "auth works",
          fullName: "a",
          status: "passed",
          durationMs: 1,
          file: "/repo/apps/server/test/auth-flows.test.ts",
        },
      ],
    };
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [nonTax] })]);
    expect(html).not.toContain("Tax-worksheet correctness");
  });

  // Spec 18: a skip the retained history has never seen execute is NEVER RUN,
  // not SKIP. The SKIP-with-a-last-ran-date case is covered in "never-run
  // journeys (spec 18)" below, which supplies the earlier run that executed it.
  it("renders a never-executed skipped journey as NEVER RUN", () => {
    const withSkip: SuiteResult = {
      ...e2eSuite,
      tests: [
        {
          name: "journey 4: live-QA only",
          fullName: "j4",
          status: "skipped",
          durationMs: 0,
          file: "tests/journeys.spec.ts",
        },
      ],
    };
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [withSkip] })]);
    expect(html).toContain("NEVER RUN");
    expect(html).toContain("never-edge");
  });

  it("does not classify an e2e spec as a tax check (e2e excluded from tax cards)", () => {
    const trickyE2e: SuiteResult = {
      ...e2eSuite,
      tests: [
        {
          name: "e2e filings view",
          fullName: "f",
          status: "passed",
          durationMs: 1,
          file: "tests/filings.spec.ts",
        },
      ],
    };
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [trickyE2e] }),
    ]);
    expect(html).toContain("End-to-end journeys");
    expect(html).not.toContain("Tax-worksheet correctness"); // e2e spec never becomes a tax card
  });
});

// --- spec 18 (PAY-55): honest status ---------------------------------------

function testResult(
  name: string,
  status: TestResult["status"],
  over: Partial<TestResult> = {},
): TestResult {
  return { name, fullName: name, status, durationMs: 100, file: "qa.spec.ts", ...over };
}

function makeE2eSuite(tests: TestResult[]): SuiteResult {
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const flaky = tests.filter((t) => t.status === "flaky").length;
  const skipped = tests.filter((t) => t.status === "skipped").length;
  return {
    key: "e2e",
    name: "Playwright journeys",
    status: failed > 0 ? "failed" : flaky > 0 ? "passed_with_flakes" : "passed",
    durationMs: 1000,
    counts: {
      passed,
      failed,
      flaky,
      skipped,
      executed: passed + failed + flaky,
      total: tests.length,
    },
    tests,
  };
}

describe("flaky headline (spec 18)", () => {
  const flakyRun = summary({
    generatedAt: "2026-09-22T21:44:42.000Z",
    overallStatus: "passed_with_flakes",
    counts: { passed: 13, failed: 0, flaky: 1, skipped: 0, executed: 14, total: 14 },
    suites: [
      makeE2eSuite([testResult("config page: State taxes tab renders", "flaky", { attempts: 2 })]),
    ],
  });

  it("never shows a plain PASSED badge for a run with flakes", () => {
    const html = renderPage([flakyRun]);
    expect(html).toContain("PASSED (FLAKY)");
    expect(html).not.toMatch(/badge pass">PASSED</);
  });

  it("shows the flake count in the headline", () => {
    expect(renderPage([flakyRun])).toMatch(/1<\/strong> flaky/);
  });

  it("omits the flake figure entirely when the count is unknown (upgraded v1)", () => {
    const v1ish = summary({
      generatedAt: "2026-09-21T21:44:42.000Z",
      counts: { passed: 10, failed: 0, skipped: 0, executed: 10, total: 10 },
    });
    expect(renderPage([v1ish])).not.toContain("flaky");
  });
});

describe("never-run journeys (spec 18)", () => {
  const older = summary({
    generatedAt: "2026-09-21T10:00:00.000Z",
    suites: [
      makeE2eSuite([
        testResult("ran once, skipped now", "passed"),
        testResult("never ran at all", "skipped", {
          skipReason: "live-QA only — needs seed-qa Dave",
        }),
      ]),
    ],
  });
  const latest = summary({
    generatedAt: "2026-09-22T10:00:00.000Z",
    suites: [
      makeE2eSuite([
        testResult("ran once, skipped now", "skipped", { skipReason: "ephemeral state missing" }),
        testResult("never ran at all", "skipped", {
          skipReason: "live-QA only — needs seed-qa Dave",
        }),
      ]),
    ],
  });
  const history = [older, latest];

  it("maps each test to the newest run that actually executed it", () => {
    const map = lastExecutedAtByTest(history);
    const at = (name: string) => lastExecutionOf("e2e", testResult(name, "skipped"), map);
    expect(at("ran once, skipped now")).toBe("2026-09-21T10:00:00.000Z");
    expect(at("never ran at all")).toBeUndefined();
  });

  it("scopes by suite, so a same-named test in another suite cannot vouch for it", () => {
    const map = lastExecutedAtByTest(history);
    // "ran once, skipped now" executed in the e2e suite only.
    expect(
      lastExecutionOf("engine", testResult("ran once, skipped now", "skipped"), map),
    ).toBeUndefined();
  });

  it("labels a test no retained run ever executed as NEVER RUN", () => {
    expect(renderPage(history)).toContain("NEVER RUN");
  });

  it("states the skip reason on the never-run card", () => {
    expect(renderPage(history)).toContain("live-QA only — needs seed-qa Dave");
  });

  it("keeps a plain SKIP, with its last-executed instant, for one that has run before", () => {
    const html = renderPage(history);
    expect(html).toMatch(/last ran 2026-09-21 10:00:00 UTC/);
  });

  it("counts never-run tests separately instead of folding them into total passed", () => {
    expect(renderPage(history)).toMatch(/1<\/strong> never run/);
  });
});

describe("not_run suites (spec 18)", () => {
  it("renders NOT RUN, never PASSED, for a suite in which nothing executed", () => {
    const run = summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      overallStatus: "not_run",
      counts: { passed: 0, failed: 0, flaky: 0, skipped: 3, executed: 0, total: 3 },
      suites: [suite("e2e", "Playwright journeys", 0, 0, 3)],
    });
    const html = renderPage([run]);
    expect(html).toContain("NOT RUN");
    expect(html).not.toContain(">PASSED<");
  });
});

describe("footer (spec 18)", () => {
  it("declares schema v2", () => {
    expect(renderPage([summary({ generatedAt: "2026-09-22T10:00:00.000Z" })])).toContain(
      "summary schema v2",
    );
  });

  it("flags a stale deploy when the newest run predates the page build", () => {
    expect(renderPage([summary({ generatedAt: "2020-01-01T00:00:00.000Z" })])).toContain(
      "newest run is",
    );
  });
});

describe("never-run demotes the headline (spec 18)", () => {
  const withGap = [
    summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      counts: { passed: 10, failed: 0, flaky: 0, skipped: 1, executed: 10, total: 11 },
      suites: [
        makeE2eSuite([
          testResult("ran", "passed"),
          testResult("never ran", "skipped", { skipReason: "live-QA only" }),
        ]),
      ],
    }),
  ];

  it("never shows a bare PASSED in the current-state sections", () => {
    const html = renderPage(withGap);
    // Headline AND the suite row — the page must not contradict itself about
    // what is true NOW. The "Recent runs" table below is excluded on purpose:
    // it records what each run itself reported and must not be rewritten.
    const currentState = html.slice(0, html.indexOf("Recent runs"));
    expect(currentState.match(/PASSED · 1 NEVER RUN/g)).toHaveLength(2);
    expect(currentState).not.toMatch(/badge pass">PASSED</);
  });

  it("leaves a clean run's headline alone", () => {
    const clean = summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      suites: [makeE2eSuite([testResult("ran", "passed")])],
    });
    expect(renderPage([clean])).toMatch(/badge pass">PASSED</);
  });

  it("does not soften a FAILED headline into the never-run wording", () => {
    const failed = summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      overallStatus: "failed",
      counts: { passed: 9, failed: 1, flaky: 0, skipped: 1, executed: 10, total: 11 },
      suites: [
        makeE2eSuite([
          testResult("boom", "failed"),
          testResult("never ran", "skipped", { skipReason: "live-QA only" }),
        ]),
      ],
    });
    const html = renderPage([failed]);
    expect(html).toContain('badge fail">FAILED');
    expect(html).not.toContain("NEVER RUN·");
  });
});
