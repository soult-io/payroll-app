# Spec 19 — pay-verify v2, chunk H: the per-source view

PAY-58, child of PAY-54. Supersedes spec 18's "latest run" model.

## Why

The page renders `sortByGeneratedAtDesc(history)[0]` — one "latest run",
whichever summary is newest. Until 2026-09-24 every ingested summary was
`source: ci`, so that was harmless. The nightly started working that day, and
the two sources do not measure the same thing:

| source    | what it runs                              | size |
| --------- | ----------------------------------------- | ---- |
| `ci`      | engine + server + **ephemeral** e2e       | ~567 |
| `nightly` | **live-QA** e2e only                      | ~21  |

So the headline now flips between "567 tests, PASSED" and "21 tests, FAILED"
depending on which finished last, and on a nightly the unit and integration
suites vanish from the page entirely. At the time of writing the newest
summary is a failing nightly, so the next build of the site would show 11
passed / 1 failed and no unit coverage at all.

There is a second, worse problem behind it. The nightly did not report for
**23 consecutive nights** and the dashboard said nothing — it simply kept
rendering the newest `ci` summary and looked healthy. A page whose entire job
is "can I trust this" has to say when a source it expects has gone quiet.
Silence is the failure mode that cost three weeks here.

## Model

A *source view* is what one source most recently said, plus how long ago:

```ts
interface SourceView {
  source: Source;
  /** undefined = this source has NEVER reported. */
  latest: VerifySummary | undefined;
  ageHours: number | undefined;
  stale: boolean;
}
```

`EXPECTED_SOURCES` is every member of the `Source` enum. A source is always
represented, even with no history at all — an absent card is indistinguishable
from a healthy one, which is precisely how the dead nightly hid.

### Freshness is per source, because the cadences differ

| source    | cadence            | stale after |
| --------- | ------------------ | ----------- |
| `ci`      | every push to main | 14 days     |
| `nightly` | daily cron         | 36 hours    |

`ci` silence is not automatically wrong — a fortnight with no pushes is quiet,
not broken — so its threshold is generous. `nightly` is a cron: a missed day is
a fault, and 36h gives one run's slack.

## Page

### Headline

One overall badge, computed as the worst outcome across the source views, by
this ranking:

```
failed  >  not_run  >  passed_with_flakes  >  passed
```

Then demoted further, in the spec-18 sense, by anything unproven:

- any never-run test → `PASSED · N NEVER RUN` (existing rule, unchanged)
- any expected source that is **stale** or has **never reported** → the badge
  cannot be plain green, and says which source and for how long

A green headline therefore requires: every suite green, nothing flaky, nothing
never-run, and every expected source reporting recently. That is the whole
point — the badge is a claim about the *system*, not about one run.

### Source cards

One per expected source, each carrying its own badge, counts, commit, instant
and freshness line. A source that has never reported renders a distinct
**NEVER REPORTED** card naming what should produce it, not an empty space.

### Suites

The union across source views, each row attributed to the source and run that
produced it. `ci`'s e2e and `nightly`'s e2e are different environments and stay
separate rows, labelled.

### Journeys

The journey set is the union of the e2e tests in each source's latest summary.
For each, status resolves to the **most recent run that actually executed it**,
across all history and both sources, and the card says which source that was
and when. A live-QA-only journey must therefore never read as never-run merely
because `ci` skipped it — the defect this rule exists to prevent.

A journey no retained run has executed keeps its spec-18 **NEVER RUN** chip.

### Tax-worksheet cards

Sourced from whichever view has non-e2e suites (`ci`). A nightly-only page
would otherwise drop them.

### Recent runs

Unchanged — it already carries a source column, and it is a log of what each
run reported, which stays true per row.

## Back-compat

v1 history upgrades as before. A history with only `ci` summaries renders with
a `nightly` card reading NEVER REPORTED — which is correct and is exactly the
warning that was missing.

## Acceptance

1. A history whose newest summary is a nightly still shows the ci suites,
   counts and tax cards; the headline does not shrink to 21 tests.
2. A history with no nightly summary shows a NEVER REPORTED nightly card and
   cannot render a plain green headline.
3. A nightly older than 36h is reported stale, with the age, and demotes the
   headline. A ci summary of the same age is not.
4. A journey executed only by the nightly shows that source's result, not
   NEVER RUN.
5. A journey no retained run has executed still shows NEVER RUN.
6. The worst outcome across sources wins the headline: a failing nightly beside
   a passing ci renders FAILED.
7. v1-only history renders.
8. The repo gate passes: lint (no new errors), build, typecheck incl. tests,
   and the full test suite.
