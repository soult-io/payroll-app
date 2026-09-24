# Spec 20 — pay-verify v2, chunk I: visual journey evidence

PAY-78, child of PAY-54. Folds in chunk G (PAY-57, per-step screenshots).
Ports what ta-verify shipped as "Phase 3c" on 2026-09-24
(soult-io/teacher-assistant PRs 66–72; replication playbook in Second Brain
#3792). Builds on spec 18 (honest status) and spec 19 (per-source view).

## Why

A journey card today is a chip and a line of text. It says a journey passed; it
does not show what the journey did. The owner cannot trust a claim he cannot
see ("very superficial, no visual user journeys", 2026-09-24).

This chunk adds two kinds of evidence to each journey card: a screenshot at the
end of every step, and a human-pace walkthrough video with a visible cursor.

## Owner rulings (binding, carried over from ta-verify unchanged)

- **R1.** Video is only useful at human interaction speed. The fast gating-run
  video is never shown on a card. It may appear only as a raw-evidence link.
- **R2.** Slow the *recording* (slowMo plus holds), never the playback rate.
- **R3.** The video shows the interaction: a cursor, a highlight on the target,
  and a click indicator.
- **R4.** Step screens are hidden until requested. A failed card opens on its
  failure screen. A passed card with a walkthrough opens on the video.
- **R5.** Provenance or nothing. Nothing is shown unless a real CI run produced
  it. A flaky test is never shown as a clean pass. Stale evidence is never
  published.

## Owner decisions for this chunk (2026-09-24)

| # | question | decision |
|---|---|---|
| D1 | where media lives between runs | orphan branch `pay-verify-assets`, force-pushed as a single commit holding only the latest bundle per source. Site image media budget 100 MB. |
| D2 | where capture runs | only the **ephemeral CI** e2e run (throwaway DB, fake seed values), never the nightly live-QA run. Reason: CI runs once per commit, so the evidence binds to the exact commit it sits beside. **No step denylist:** all QA and CI data is synthetic (spec `qa-environment.md`, D31), so every step is captured. |
| D3 | multi-context journeys | CI stitches the per-context clips into **one webm per journey**, in step order, with a caption card at each context switch. |
| D4 | which tests are journeys | `journeys.spec.ts`, the chunk-F journeys in `qa.spec.ts`, and `state-taxes.spec.ts`. Utility specs (`mobile-login`, `qa-helpers`) get no media. |

## Model

### Steps

A journey is a sequence of named steps. Each journey test is written with a
`step(page, title, fn)` helper (`e2e/tests/support/journey.ts`). The page is
passed explicitly because payroll journeys switch between separately created
browser contexts (admin, employee); the helper must not assume the built-in
`page` fixture.

At the end of every step, including a step that throws, the helper captures one
still of the page the step names:

- chromium only (the only project today; the helper refuses to run elsewhere
  rather than silently skipping);
- JPEG, quality 70, `fullPage: true` — apps/web scrolls the document, not an
  inner container (`#app { min-height: 100vh }`), so fullPage is correct. The
  helper asserts this at capture time: if `document.scrollingElement` is not
  the tallest scroller, it fails the still with `reason: "inner-scroller"`
  rather than emit a one-viewport image as if it were whole;
- height capped at 4000 CSS px; a capped still carries `truncated: true`.

Every step is captured; there is no denylist (D2). Payroll screens show SSN and
tax-ID fields, but in the ephemeral CI run their values come from the synthetic
seed. This relies on the standing rule that no real data enters CI or QA; if
that rule ever changes, capture must be revisited before it does.

### Evidence file

A reporter (`e2e/reporters/evidence-reporter.ts`) writes
`journey-evidence.json`, schema `journey-evidence/1`, next to the stills:

```ts
interface JourneyEvidence {
  schema: "journey-evidence/1";
  mode: "gating" | "walkthrough";
  commitSha: string;          // GITHUB_SHA of the run that captured it
  runId: string;              // GITHUB_RUN_ID
  source: "ci";               // D2: never "nightly"
  generatedAt: string;
  journeys: Array<{
    testId: string;           // Playwright's stable test id
    fullName: string;         // file + describes + title: joins to summary tests[].fullName
    title: string;
    file: string;             // spec file basename
    status: "passed" | "failed" | "flaky" | "skipped" | "timedOut";
    attempt: number;          // the FINAL attempt is kept
    steps: Array<{
      title: string;
      status: "passed" | "failed";
      durationMs: number;
      screenshot:
        | { path: string; contentType: "image/jpeg";
            width: number; height: number; truncated: boolean }
        | null;               // no still (never a placeholder)
      videoOffsetMs?: number; // walkthrough only: step start in the stitched video
    }>;
    video?: { path: string; contentType: "video/webm"; durationMs: number };
  }>;
}
```

`screenshot` is always present. `null` means "no still was produced" and the
page says so; it never falls back to the previous step's image. A still whose
size record is missing or unreadable is dropped to `null`, never guessed.

The summary carries no Playwright test id, so the join is by `fullName`, which
the reporter builds exactly as the summary's Playwright aggregator does
(`titlePath()` minus the root and project). Still `path`s are relative to the
evidence file's directory (`e2e/test-results/`), so file and stills move as
one bundle. `attach()` copies each still under `attachments/`, named by a hash of
its source path,; the helper deletes the original so each still is stored once.
The e2e job uploads the bundle as the `pay-verify-evidence` artifact, pass or
fail.

The zod schema lives in `@payroll/verify-summary` (`src/evidence.ts`), beside
the summary schema, and runs the existing PII guard over every string leaf
(titles, step titles, paths). The summary schema is **not** changed; evidence
is a separate file joined by `testId` and bound by `runId` + `commitSha`.

### Walkthrough mode

A separate, **non-gating** Playwright run, `E2E_WALKTHROUGH=1`:

- chromium; `slowMo` 300 ms; typing 80 ms per character;
- a hold of at least 1.5 s at the end of every step, **and** before any action
  when the screen changed since the last hold (new route, dialog or sheet
  opened, rows added or removed). Without the second rule a screen reached
  mid-step flashes for ~0.3 s (the ta-verify PR 68 defect);
- every context is created with `recordVideo`; after the run a script stitches
  each journey's clips into one webm with ffmpeg, inserting a 1.5 s caption
  card ("Now signed in as employee") at each context switch, and writes
  `videoOffsetMs` per step;
- **refuses to start** if `E2E_BASE_URL` is set: it runs only against the
  ephemeral CI app on localhost;
- reuses saved sessions where the gating run does, so human pace stays inside
  the 10 req/min credential rate limit.

The walkthrough runs in its own `walkthrough` job in `ci.yml` after `e2e`, on
push to main only, `continue-on-error`. Its evidence carries `mode:
"walkthrough"` and the same `commitSha` as the gating run. A walkthrough whose
commit does not match the gating evidence it would sit beside is **not shown**.

### Cursor overlay (walkthrough only)

Injected by the test harness through `context.addInitScript`, never shipped in
the app, and only when `E2E_WALKTHROUGH=1`:

- a cursor glides to the target (450 ms);
- a pink ring (`#ec4899`, a colour apps/web does not use) holds on the target
  ~500 ms before the action;
- then a `Click · <accessible name>` caption and a ripple; typed fields get a
  dashed focus ring;
- `pointer-events: none`, `position: fixed`, no layout shift, re-injected on
  navigation;
- overlay DOM changes do not count as a screen change for the hold;
- hidden targets are skipped, with a backstop timer so a missing target cannot
  hang the run.

The gating run never loads the overlay, so gating stills contain no overlay
pixels.

### Storage and publishing (D1)

`ci.yml` uploads a `pay-verify-evidence` artifact (evidence JSON, stills,
stitched videos) from `e2e` and, when present, from `walkthrough`.

`pay-verify-site.yml`, on a ci `workflow_run`:

1. downloads the evidence artifact(s) of the triggering run;
2. validates them (schema, JPEG/WebM magic bytes, still ≤ 2 MiB and ≤ 4000 px
   tall, video ≤ 20 MB, total ≤ 100 MB, paths confined to the bundle root);
3. replaces the `ci/` directory on `pay-verify-assets` with this bundle and
   force-pushes the branch as one commit (the history branch stays text-only);
4. the generator copies the bundle into the site and attaches it to a journey
   card only when the bundle's `runId` equals the run the card's result came
   from (spec 19 picks that run). Otherwise the card reads "no evidence for
   this run".

A nightly `workflow_run` never touches `pay-verify-assets` (D2).

### Same-commit publishing (fixes a live defect)

`pay-verify-site.yml` currently checks out the default ref and tags the image
`sha-${{ github.sha }}`. Under `workflow_run` both are main's tip at the time
the site job starts, not the commit that was tested. The report copied into
`/report/` is whichever run finished last. Changes:

- check out and tag `github.event.workflow_run.head_sha`;
- gate on `head_repository.full_name == github.repository`, `head_branch ==
  'main'`, and `event` in (`push`, `schedule`, `workflow_dispatch`) — never
  `pull_request`;
- re-read the triggering run from the API and confirm `head_sha`, `event`,
  `head_branch`, repository and `run_attempt` before publishing;
- a three-way assert before the push, logged as
  `tag sha-X | checkout X | evidence X`, fails the job on any mismatch;
- `:latest` moves only if `head_sha` is still main's tip;
- no `${{ }}` of `workflow_run` free-text fields (titles, branch names, commit
  messages) inside `run:` — pass them through `env:`;
- publish runs are never cancelled (the existing `cancel-in-progress: false`).

Note for anyone checking a run: `gh run list` shows main's tip as `headSha`
for `workflow_run` runs. The assert log line is the record of the real commit.

## Page

### Journey card media (viewer)

A passed card with a same-commit walkthrough opens on **Video**. A failed card
opens on **Screens**, at the failing step. Every other card starts collapsed
with a "Show screens" control (R4).

- **Video | Screens** tabs. The Video tab exists only when a same-commit
  walkthrough exists; its label reads `walkthrough · run #N`, linking to the
  run.
- The step list drives both views. Selecting a step seeks the video to its
  `videoOffsetMs` or shows that step's still; switching tabs keeps the step.
- Tall stills fit to width and scroll inside the stage, never squashed.
  Prev/Next, step dots, "open full size ↗", `width×height`, a "truncated at
  capture limit" note when `truncated`.
- A step with no still reads "No screen captured for this step". It never
  shows another step's image.
- A flaky journey labels which attempt the media came from and keeps its
  flaky chip. An UNVERIFIED or NEVER RUN journey shows no media.
- Lazy: zero image or video requests on page load. Without JS, each step has a
  plain "Screen ↗" link.
- The fast gating-run video, if any, is only a raw-evidence link (R1).
- Light and dark themes; no horizontal scroll at 375 px; keyboard and
  screen-reader operable.

`nginx.conf` serves `/media/` with the correct content types.

## Build order (one PR each)

1. This spec.
2. Same-commit publishing in `pay-verify-site.yml` (independent; fixes a live
   defect).
3. `step` helper, stills, evidence reporter; wrap the D4 journeys in
   steps; upload the evidence artifact.
4. Evidence schema + validation in `verify-summary`; `pay-verify-assets`
   branch; generator copies media and renders a Screens-only viewer.
5. Walkthrough mode, screen-change hold, ffmpeg stitch, `walkthrough` job.
6. Cursor overlay.
7. Video | Screens tabs and the R4 open-state rules.

## Back-compat

History without evidence renders exactly as today, with no media section. A
bundle for an older run than the card's result is ignored. The summary schema
is unchanged.

## Acceptance

1. Every D4 journey step produces a still or an explicit `null`
   record; no step is missing from the evidence.
2. A still taller than 4000 px is cut at 4000 and flagged `truncated`.
3. No evidence is captured from the nightly run; `pay-verify-assets` holds a
   `ci/` bundle only.
4. The PII guard rejects an evidence file with a PII string in any title or
   path.
5. From a **real CI run**, decode the walkthrough frames: every screen stays on
   screen at least 1.5 s, and every click and type frame shows the cursor
   inside the ring.
6. Gating stills contain no overlay pixels (`#ec4899` count = 0). Gating
   pass/fail is unchanged by this chunk.
7. The walkthrough refuses to start when `E2E_BASE_URL` is set.
8. A site built from a run whose evidence commit differs from the checkout or
   tag commit fails the publish job; the assert line is in the log.
9. A PR run never triggers a publish.
10. Download the CI-built site, serve it, and render it at desktop and 390 px,
    light and dark: failed card opens on its failing step, passed card on
    video, zero media requests on load, no horizontal scroll.
11. A card whose result came from a run with no evidence bundle says "no
    evidence for this run".
12. The repo gate passes: lint (no new errors), build, typecheck incl. tests,
    and the full test suite.
