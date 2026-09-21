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
