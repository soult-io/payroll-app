import { describe, expect, it } from "vitest";
import {
  buildSummary,
  fromPlaywrightReport,
  fromVitestReport,
  type SummaryMeta,
} from "../src/aggregate.js";
import { SCHEMA_VERSION } from "../src/schema.js";

const META: SummaryMeta = {
  runId: "run-1",
  source: "ci",
  gitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
  gitRef: "refs/heads/main",
  generatedAt: "2026-09-21T12:00:00.000Z",
};

describe("fromVitestReport", () => {
  const report = {
    testResults: [
      {
        name: "/repo/packages/engine/test/futa.test.ts",
        assertionResults: [
          {
            title: "zero credit -> 6.0% net",
            ancestorTitles: ["940 worksheet"],
            status: "passed",
            duration: 3,
          },
          {
            title: "rejects a credit above statutory",
            ancestorTitles: ["940 worksheet"],
            status: "failed",
            duration: 5,
          },
        ],
      },
      {
        name: "/repo/packages/engine/test/state.test.ts",
        assertionResults: [
          {
            title: "skips with no election",
            ancestorTitles: [],
            status: "skipped",
            duration: null,
          },
        ],
      },
    ],
  };

  it("flattens assertions, maps status, sums duration, derives fullName + file", () => {
    const suite = fromVitestReport(report, { key: "engine", name: "Engine unit tests" });
    expect(suite.key).toBe("engine");
    expect(suite.counts).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(suite.status).toBe("failed");
    expect(suite.durationMs).toBe(8);
    expect(suite.tests[0]).toEqual({
      name: "zero credit -> 6.0% net",
      fullName: "940 worksheet zero credit -> 6.0% net",
      status: "passed",
      durationMs: 3,
      file: "/repo/packages/engine/test/futa.test.ts",
    });
    // null duration → 0; pending/todo/skipped all collapse to "skipped".
    expect(suite.tests[2]?.durationMs).toBe(0);
  });

  it("passes when only skipped/empty", () => {
    const suite = fromVitestReport(
      { testResults: [] },
      { key: "server", name: "Server integration tests" },
    );
    expect(suite.status).toBe("passed");
    expect(suite.counts.total).toBe(0);
  });
});

describe("fromPlaywrightReport", () => {
  const report = {
    suites: [
      {
        title: "journeys.spec.ts",
        file: "tests/journeys.spec.ts",
        specs: [
          {
            title: "journey 1: onboarding",
            file: "tests/journeys.spec.ts",
            tests: [{ status: "expected", results: [{ status: "passed", duration: 100 }] }],
          },
          {
            title: "journey 2: payroll",
            file: "tests/journeys.spec.ts",
            tests: [
              {
                status: "unexpected",
                results: [
                  { status: "failed", duration: 50 },
                  { status: "failed", duration: 40 },
                ],
              },
            ],
          },
        ],
        suites: [
          {
            title: "nested group",
            specs: [{ title: "sub spec", tests: [{ status: "skipped", results: [] }] }],
            suites: [],
          },
        ],
      },
    ],
  };

  it("recurses nested suites, maps statuses, builds the title path", () => {
    const suite = fromPlaywrightReport(report, { key: "e2e", name: "Playwright journeys" });
    expect(suite.counts).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(suite.status).toBe("failed");
    expect(suite.durationMs).toBe(190);
    expect(suite.tests[0]?.fullName).toBe("journeys.spec.ts journey 1: onboarding");
    expect(suite.tests[1]?.status).toBe("failed");
    const sub = suite.tests[2];
    expect(sub?.fullName).toBe("journeys.spec.ts nested group sub spec");
    expect(sub?.status).toBe("skipped");
    // nested group has no file and the spec has none → file omitted entirely.
    expect(sub && "file" in sub).toBe(false);
  });

  it("treats a flaky spec (passed on retry) as passed", () => {
    const flaky = {
      suites: [
        {
          title: "j.spec.ts",
          specs: [
            {
              title: "eventually green",
              tests: [
                {
                  status: "flaky",
                  results: [
                    { status: "failed", duration: 30 },
                    { status: "passed", duration: 20 },
                  ],
                },
              ],
            },
          ],
          suites: [],
        },
      ],
    };
    const suite = fromPlaywrightReport(flaky, { key: "e2e", name: "Playwright journeys" });
    expect(suite.tests[0]?.status).toBe("passed");
    expect(suite.tests[0]?.durationMs).toBe(50);
    expect(suite.status).toBe("passed");
  });
});

describe("buildSummary", () => {
  const engine = fromVitestReport(
    {
      testResults: [
        { name: "a.test.ts", assertionResults: [{ title: "ok", status: "passed", duration: 1 }] },
      ],
    },
    { key: "engine", name: "Engine unit tests" },
  );
  const server = fromVitestReport(
    {
      testResults: [
        { name: "b.test.ts", assertionResults: [{ title: "ok", status: "passed", duration: 2 }] },
      ],
    },
    { key: "server", name: "Server integration tests" },
  );

  it("sums counts and passes when all present + green", () => {
    const s = buildSummary([engine, server], { ...META, requiredSuiteKeys: ["engine", "server"] });
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.overallStatus).toBe("passed");
    expect(s.counts).toEqual({ passed: 2, failed: 0, skipped: 0, total: 2 });
  });

  it("fails when a required suite is missing even if present suites are green", () => {
    const s = buildSummary([engine], { ...META, requiredSuiteKeys: ["engine", "server"] });
    expect(s.overallStatus).toBe("failed");
  });

  it("fails when any suite failed", () => {
    const failing = fromVitestReport(
      {
        testResults: [
          {
            name: "c.test.ts",
            assertionResults: [{ title: "boom", status: "failed", duration: 1 }],
          },
        ],
      },
      { key: "server", name: "Server integration tests" },
    );
    const s = buildSummary([engine, failing], META);
    expect(s.overallStatus).toBe("failed");
  });

  it("passes with no required keys and only skipped tests", () => {
    const skipped = fromVitestReport(
      {
        testResults: [
          {
            name: "d.test.ts",
            assertionResults: [{ title: "later", status: "skipped", duration: null }],
          },
        ],
      },
      { key: "e2e", name: "Playwright journeys" },
    );
    const s = buildSummary([skipped], META);
    expect(s.overallStatus).toBe("passed");
  });
});
