# Spec 18 — pay-verify v2, chunk E: honest status

PAY-55, child of PAY-54. Supersedes the status semantics of spec 17 §1.2.

## Why

The dashboard reports green for things that are not green. Three independent
mechanisms combine to do it, and a fourth defect hides behind them.

1. **Flaky is relabelled PASS.** `aggregate.ts playwrightSpecStatus()` returns
   `"passed"` for a spec that failed and then passed on retry — deliberately,
   per its own comment. The summary schema is tri-state
   (`passed | failed | skipped`), so flake has nowhere to live. Observed on the
   live site 2026-09-24: `state-taxes.spec.ts` "config page: State taxes tab
   renders" has results `[timedOut, passed]` and Playwright's own `report.json`
   carries `stats.ok: false`, while the dashboard headline reads **PASSED** and
   the card reads "PASS · 1m 01s" — where that minute *is* the timed-out
   attempt.

2. **Skipped counts as passed.** `outcomeFromCounts()`: "any failure fails;
   skipped-only or empty passes". A suite in which nothing executed is reported
   `passed`.

3. **Never-run tests inflate the headline.** The six `LIVE_QA`-gated journeys in
   `qa.spec.ts` have never executed in any of the summaries ingested on the
   `pay-verify-data` branch (all 10 are `source: ci`; `LIVE_QA` is set only by
   the nightly). They are nonetheless folded into "548 total" and rendered with
   the same neutral SKIP chip a normally-skipped test gets.

4. **The flake is a real bug, not noise.** `e2e/tests/qa.ts` `loginAs()` waits
   out the credential rate-limit window with `page.waitForTimeout(65_000)`,
   inside a suite whose `e2e/playwright.config.ts` sets `timeout: 60_000`. The
   backoff is strictly longer than the whole test budget, so the retry path can
   never complete — every throttled login is a guaranteed timeout.

Chunk E fixes the reporting. Chunks F (make the six run) and G (visual
evidence) follow.

## Scope

`packages/verify-summary`, `packages/verify-site`, `e2e/tests/qa.ts`. No change
to CI workflow wiring, no change to what the suites test.

## Schema v2

`SCHEMA_VERSION` → `2`.

### `TestStatus` gains `flaky`

```
passed | failed | flaky | skipped
```

`flaky` = the test ultimately passed but at least one earlier attempt failed,
timed out or was interrupted. It is **not** a pass and **not** a failure; it is
its own bucket, and it never merges into either.

### `Outcome` gains `passed_with_flakes` and `not_run`

```
passed | passed_with_flakes | failed | not_run
```

Applied to both `SuiteResult.status` and `VerifySummary.overallStatus`:

| condition (checked in order)            | outcome              |
| --------------------------------------- | -------------------- |
| any failed test, or a required suite missing | `failed`         |
| nothing executed (`executed === 0`)     | `not_run`            |
| any flaky test                          | `passed_with_flakes` |
| otherwise                               | `passed`             |

`not_run` is deliberately not `passed`. A suite that ran nothing has proven
nothing.

### `Counts`

Adds:

- `flaky` — **optional**. Absent means *unknown*, which is the honest value for
  a v1 summary upgraded forward: v1 folded flakes into `passed` and the
  information is not recoverable. The renderer must print nothing rather than
  `0` when it is absent.
- `executed` — `passed + failed + flaky`. Always derivable, so always present.

`total` keeps its meaning (every test the reporter emitted, skips included).

### `TestResult`

Adds, all optional:

- `attempts` — number of reporter result entries (1 for a clean pass).
- `firstFailure` — first line of the first failing attempt's error, trimmed and
  capped at 200 characters. Answers "flaky *how*" without shipping a codeframe.
- `skipReason` — the Playwright `skip` annotation's description, e.g.
  "live-QA only — needs the seeded contractor login (seed-qa Dave)". A skip with
  no stated reason stays `undefined`; the renderer says "no reason recorded".

`firstFailure` and `skipReason` are free text from the suites, so they pass
through the existing PII guard like every other field.

### Back-compat

The retained history window is entirely v1 and must keep rendering. The site
parses with `parseSummary()`, which tries v2 and falls back to v1 + `upgradeV1()`:

- `schemaVersion` → 2
- `counts.flaky` → left **absent** (unknown, per above)
- `counts.executed` → `passed + failed` (correct for v1: a v1 flaky was counted
  in `passed`, so it was executed either way)
- `overallStatus` / suite `status` → carried across unchanged; `passed` and
  `failed` mean the same in both versions
- per-test `attempts` / `firstFailure` / `skipReason` → absent

An unparseable-as-either file is skipped with a warning, as today.

## Site behaviour

### Headline

`passed_with_flakes` renders an amber **PASSED (FLAKY)** badge and an amber
status edge, distinct from green `passed` and red `failed`. `not_run` renders a
muted **NOT RUN**.

Counts line splits executed from total:

```
542 passed · 1 flaky · 0 failed · 6 never run · 549 total   (executed 543)
```

`flaky` is omitted entirely when `counts.flaky` is absent.

### NEVER RUN

Computed by the site across the whole ingested history, not stored per summary —
a single summary cannot know what other runs did.

`lastExecutedAtByTest(history)` maps *(suite key, `fullName`)* → the
`generatedAt` of the most recent summary in which that test's status was
`passed`, `failed` or `flaky`. The key is scoped by suite deliberately:
`fullName` alone collides across suites (engine and server can both hold
`FUTA credit caps at 5.4%`), and a collision would let one suite's run date
vouch for the other suite's never-run test — the exact misreport this section
exists to prevent.
For a test that is `skipped` in the latest run:

- present in the map → chip reads `SKIP`, subtitle "last ran 2026-09-21 22:44 UTC"
- absent from the map → chip reads **NEVER RUN**, subtitle is the `skipReason`,
  and the card takes a distinct warning edge

Never-run tests are counted in their own `neverRun` figure in the headline and
are excluded from the passed number.

### Footer

`summary schema v2`, and it states when the newest run in the history is older
than the page's own generation time, so a stale deploy is visible on its face.

## e2e fix

`loginAs()` keeps the 65s backoff — the rate-limit window is real and a shorter
wait would not clear it — but it now extends the *current test's* budget before
sleeping, so the happy path keeps its tight 60s and only a genuinely throttled
run runs long:

```ts
export const LOGIN_RATE_LIMIT_BACKOFF_MS = 65_000;
export const LOGIN_BACKOFF_SLACK_MS = 15_000;

export function extendedTimeoutMs(currentMs: number, backoffMs: number): number;
```

`extendedTimeoutMs` is a pure function so the invariant is testable without a
browser: the returned budget must exceed `current + backoff`, for every
`current` including `0` (Playwright's "no timeout").

## Review amendments

Added after the correctness and code-quality reviews of the first implementation:

- **Status resolution fails closed.** Playwright's test-level status is one of
  `expected | unexpected | flaky | skipped`; anything absent or unrecognized is
  resolved from the attempts rather than falling through to `passed`. `spec.ok`
  is used as a floor — it can turn a computed pass into a failure, never the
  reverse, and never touches a skip (Playwright reports `ok: false` for those
  too).
- **An unknown flake count is contagious.** If any contributing suite's `flaky`
  is absent, the total is absent. A total that silently omitted the unknown
  part would be rendered as fact.
- **A run that executed nothing has no pass rate.** `passRate` returns
  `undefined`, and the history row renders `—` instead of a full-width
  "100% pass" bar. The empty-history page is muted, not green.
- **Never-run demotion is one rule.** `demoted(status, neverRun)` is shared by
  the headline and the suite row, so the two cannot drift apart. A `failed`
  verdict is never softened.
- **Unreadable history files are counted, not just logged.** `loadHistory`
  returns `{ summaries, skipped }` and the footer states how many files it
  could not read — otherwise a malformed summary vanishes from the page with
  the only signal in a CI log.
- **`firstFailure` renders on failed cards too**, not only flaky ones.
- **`test/` is now typechecked** (`tsconfig.test.json` per package, wired into
  the `typecheck` script). The build config covers `src` only, so schema-invalid
  fixtures compiled fine and produced `NaN` at runtime while their assertions
  still passed. Adding it immediately caught three stale fixtures.

## Acceptance

1. A Playwright report whose spec has results `[timedOut, passed]` aggregates to
   status `flaky`, `attempts: 2`, and a `firstFailure` naming the timeout.
2. A summary containing one flaky test has `overallStatus: "passed_with_flakes"`
   and renders an amber headline, never a plain PASSED.
3. A suite whose tests are all skipped has status `not_run`, not `passed`.
4. A test skipped in the latest run and never executed in any retained summary
   renders **NEVER RUN** with its skip reason; one skipped now but executed
   earlier renders SKIP with its last-executed instant.
5. Every v1 history file still renders; its flaky count prints as nothing, not
   as `0`.
6. `extendedTimeoutMs(60_000, 65_000) > 125_000`, and the e2e helper calls it
   before every backoff.
7. `tsc`, `biome ci`, `knip` and the full test suite pass.
