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
    expect(suite.counts).toEqual({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 1,
      executed: 2,
      total: 3,
    });
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

  // Spec 18 overturned the v1 rule that an empty suite "passes": a suite that
  // executed nothing has proven nothing, so it is not_run.
  it("is not_run when only skipped/empty", () => {
    const suite = fromVitestReport(
      { testResults: [] },
      { key: "server", name: "Server integration tests" },
    );
    expect(suite.status).toBe("not_run");
    expect(suite.counts.total).toBe(0);
    expect(suite.counts.executed).toBe(0);
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
    expect(suite.counts).toEqual({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 1,
      executed: 2,
      total: 3,
    });
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

  // Spec 18 overturned the v1 rule that a retry-pass is a pass.
  it("treats a flaky spec (passed on retry) as flaky, not passed", () => {
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
    expect(suite.tests[0]?.status).toBe("flaky");
    expect(suite.tests[0]?.durationMs).toBe(50);
    expect(suite.status).toBe("passed_with_flakes");
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
    expect(s.counts).toEqual({ passed: 2, failed: 0, flaky: 0, skipped: 0, executed: 2, total: 2 });
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

  it("is not_run with no required keys and only skipped tests", () => {
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
    expect(s.overallStatus).toBe("not_run");
  });
});

// --- spec 18 (PAY-55): flaky, never-run and the executed/total split --------

const FLAKY_REPORT = {
  suites: [
    {
      title: "state-taxes.spec.ts",
      file: "state-taxes.spec.ts",
      specs: [
        {
          title: "config page: State taxes tab renders",
          file: "state-taxes.spec.ts",
          ok: true,
          tests: [
            {
              status: "flaky",
              results: [
                {
                  status: "timedOut",
                  duration: 60_048,
                  errors: [{ message: "Test timeout of 60000ms exceeded.\n  at qa.ts:94" }],
                },
                { status: "passed", duration: 1_060 },
              ],
            },
          ],
        },
      ],
      suites: [],
    },
  ],
};

const SKIPPED_REPORT = {
  suites: [
    {
      title: "qa.spec.ts",
      file: "qa.spec.ts",
      specs: [
        {
          title: "tax deposits: admin sees the computed schedule incl. last month (PAY-9)",
          file: "qa.spec.ts",
          ok: false,
          tests: [
            {
              status: "skipped",
              annotations: [
                {
                  type: "skip",
                  description:
                    "live-QA only — deposit rows come from the seeded QA payroll history",
                },
              ],
              results: [{ status: "skipped", duration: 0 }],
            },
          ],
        },
      ],
      suites: [],
    },
  ],
};

describe("fromPlaywrightReport — flaky (spec 18)", () => {
  const suite = fromPlaywrightReport(FLAKY_REPORT, { key: "e2e", name: "Playwright journeys" });

  it("reports a retry-pass as flaky, never as passed", () => {
    expect(suite.tests[0]?.status).toBe("flaky");
  });

  it("records the attempt count", () => {
    expect(suite.tests[0]?.attempts).toBe(2);
  });

  it("records why the first attempt failed, first line only", () => {
    expect(suite.tests[0]?.firstFailure).toBe("Test timeout of 60000ms exceeded.");
  });

  it("counts the flake in its own bucket, not in passed", () => {
    expect(suite.counts).toMatchObject({ passed: 0, failed: 0, flaky: 1, executed: 1, total: 1 });
  });

  it("makes the suite passed_with_flakes, not passed", () => {
    expect(suite.status).toBe("passed_with_flakes");
  });
});

describe("fromPlaywrightReport — skipped (spec 18)", () => {
  const suite = fromPlaywrightReport(SKIPPED_REPORT, { key: "e2e", name: "Playwright journeys" });

  it("carries the skip reason through", () => {
    expect(suite.tests[0]?.skipReason).toBe(
      "live-QA only — deposit rows come from the seeded QA payroll history",
    );
  });

  it("is not_run when nothing executed, never passed", () => {
    expect(suite.status).toBe("not_run");
    expect(suite.counts.executed).toBe(0);
  });
});

describe("buildSummary — spec 18 outcomes", () => {
  const flaky = fromPlaywrightReport(FLAKY_REPORT, { key: "e2e", name: "Playwright journeys" });
  const skipped = fromPlaywrightReport(SKIPPED_REPORT, { key: "e2e", name: "Playwright journeys" });

  it("is passed_with_flakes when any test is flaky", () => {
    expect(buildSummary([flaky], META).overallStatus).toBe("passed_with_flakes");
  });

  it("is not_run when nothing executed anywhere", () => {
    expect(buildSummary([skipped], META).overallStatus).toBe("not_run");
  });

  it("emits schema version 2", () => {
    expect(buildSummary([flaky], META).schemaVersion).toBe(2);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("still fails outright when a required suite is missing", () => {
    expect(buildSummary([flaky], { ...META, requiredSuiteKeys: ["engine"] }).overallStatus).toBe(
      "failed",
    );
  });
});

// --- review findings: fail-closed status, contagious unknown ---------------

function pwSpec(tests: unknown[], over: Record<string, unknown> = {}) {
  return {
    suites: [
      {
        title: "s.spec.ts",
        file: "s.spec.ts",
        specs: [{ title: "t", tests, ...over }],
        suites: [],
      },
    ],
  };
}
const E2E = { key: "e2e", name: "Playwright journeys" } as const;

describe("playwrightSpecStatus fails CLOSED", () => {
  it("does not report a failing attempt as passed when the test-level status is absent", () => {
    const suite = fromPlaywrightReport(
      pwSpec([{ results: [{ status: "failed", duration: 1 }] }]),
      E2E,
    );
    expect(suite.tests[0]?.status).toBe("failed");
  });

  it("does not report a failing attempt as passed when the status is unrecognized", () => {
    const suite = fromPlaywrightReport(
      pwSpec([{ status: "whatever", results: [{ status: "timedOut", duration: 1 }] }]),
      E2E,
    );
    expect(suite.tests[0]?.status).toBe("failed");
  });

  it("derives flaky from the attempts even when the reporter never labels it", () => {
    const suite = fromPlaywrightReport(
      pwSpec([
        {
          status: "expected",
          results: [
            { status: "failed", duration: 1 },
            { status: "passed", duration: 2 },
          ],
        },
      ]),
      E2E,
    );
    expect(suite.tests[0]?.status).toBe("flaky");
  });

  it("lets spec.ok === false override a computed pass", () => {
    const suite = fromPlaywrightReport(
      pwSpec([{ status: "expected", results: [{ status: "passed", duration: 1 }] }], { ok: false }),
      E2E,
    );
    expect(suite.tests[0]?.status).toBe("failed");
  });

  it("but never turns a skip into a failure — Playwright reports ok:false for those too", () => {
    const suite = fromPlaywrightReport(
      pwSpec([{ status: "skipped", results: [{ status: "skipped", duration: 0 }] }], { ok: false }),
      E2E,
    );
    expect(suite.tests[0]?.status).toBe("skipped");
  });
});

describe("an unknown flake count is contagious", () => {
  it("leaves the total absent when any contributing suite does not know its own", () => {
    const known = fromPlaywrightReport(FLAKY_REPORT, E2E);
    const unknown: typeof known = {
      ...known,
      key: "engine",
      counts: { ...known.counts, flaky: undefined },
    };
    expect(buildSummary([known, unknown], META).counts.flaky).toBeUndefined();
  });

  it("totals it when every suite knows", () => {
    const known = fromPlaywrightReport(FLAKY_REPORT, E2E);
    expect(buildSummary([known, { ...known, key: "engine" }], META).counts.flaky).toBe(2);
  });
});
