import type { SuiteResult, VerifySummary } from "@payroll/verify-summary";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatDurationMs,
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
    status: failed > 0 ? "failed" : "passed",
    durationMs: 1000,
    counts: { passed, failed, skipped, total: passed + failed + skipped },
    tests: [],
  };
}

function summary(over: Partial<VerifySummary> & { generatedAt: string }): VerifySummary {
  const suites = over.suites ?? [suite("engine", "Engine unit tests", 10, 0, 0)];
  const counts = over.counts ?? { passed: 10, failed: 0, skipped: 0, total: 10 };
  return {
    schemaVersion: 1,
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
          counts: { passed: 3, failed: 1, skipped: 5, total: 9 },
        }),
      ),
    ).toBe(75);
    expect(
      passRate(
        summary({
          generatedAt: "2026-09-21T00:00:00Z",
          counts: { passed: 0, failed: 0, skipped: 4, total: 4 },
        }),
      ),
    ).toBe(100);
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
          counts: { passed: 185, failed: 0, skipped: 6, total: 191 },
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
        counts: { passed: 5, failed: 2, skipped: 0, total: 7 },
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
    counts: { passed: 2, failed: 0, skipped: 0, total: 2 },
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
    counts: { passed: 2, failed: 1, skipped: 0, total: 3 },
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

  it("renders a skipped journey with a SKIP badge and skip-edge", () => {
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
    expect(html).toContain(">SKIP<");
    expect(html).toContain("skip-edge");
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
