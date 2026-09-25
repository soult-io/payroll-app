# Spec 21 — pay-verify: backfill runs the history is missing

PAY-79, child of PAY-54. Follows spec 20 (PAY-78).

## Why

`pay-verify-site.yml` serializes its publishing runs in one concurrency group
(`pay-verify-site-publish`, spec 20 PR 7). GitHub keeps only **one pending**
run per group: a third arrival cancels the pending one. That cancelled run's
summary is then never ingested, and nothing reports it — the dashboard simply
never shows that run.

PR 7 already stops runs that were going to be skipped from joining the
publishing group. What remains is three *publishing* runs close together (a ci
push, a nightly, a walkthrough).

Observed so far (2026-09-25, checked against the history window): no run has
yet been lost this way. The fix is preventive.

## Model

Before its normal ingest, every publishing run of `pay-verify-site.yml`
backfills:

1. It lists the last 30 completed runs of `ci` and `e2e-nightly` on `main`.
2. The planner (`packages/verify-site/src/backfill.ts`, pure, unit-tested)
   keeps a run only when all of these hold:
   - it has no history file (files are named `<instant>-<runId>.json`);
   - it is not the triggering run (the normal ingest handles that one);
   - it fed the site: `ci` from `push` / `workflow_dispatch`, `e2e-nightly`
     from `schedule` / `workflow_dispatch`, on `main`;
   - it finished and tested something: not `cancelled` or `skipped` (a
     `failure` is a result and is kept);
   - it is not older than the oldest retained history file — an older one
     would be pruned straight away, and would resurrect a run the window had
     already let go.
3. For each kept run, the workflow ingests its summary artifact only if the
   artifact still exists (not expired) and its `gitSha` equals the run's
   `head_sha`. A run with no artifact — e.g. a nightly that failed before it
   produced one — is skipped with a log line, not a warning.
4. A single "Commit history" step then prunes to `HISTORY_KEEP` and commits the
   backfill and the ingest together, only when something changed.

The history file is named by the run's completion instant, so the rolling
window stays in chronological order.

## Out of scope

The journey evidence (stills, walkthrough) is not backfilled: the assets
branch holds only the latest ci bundle by design (spec 20 D1). A card whose
result came from a backfilled run without a bundle says "No evidence for this
run." — honest, and the next ci run replaces it.

## Acceptance

1. A completed main ci run missing from the history is ingested on the next
   publishing run, with the same content its own run would have produced.
2. Cancelled, skipped, pull-request, other-branch and pre-window runs are never
   ingested; a run without an unexpired artifact is skipped.
3. A summary whose `gitSha` differs from its run's commit is refused.
4. The repo gate passes; actionlint is clean.
