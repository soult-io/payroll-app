# Spec 17 — QA verification-visibility site (pay-verify)

Status: `PROPOSED 2026-09-21` · Depends on: Spec 14 (QA environment), Spec 16 (public readiness)
· Tracks Plane PAY-41 (epic) with chunks PAY-43 (A), PAY-44 (B), PAY-45 (C), PAY-46 (D).

A static, PII-free dashboard that makes payroll-app's QA/test verification **visible** —
modelled on `ta-verify.stabpablo.com` for Teacher Assistant. It proves the app is exercised and
correct (nightly e2e + the full test suite + tax-worksheet correctness) without exposing any
employee data. Hosted on BCN behind the reverse proxy at `pay-verify.stabpablo.eu`, access-gated
(LAN/VPN allowlist, like QA). All inputs are synthetic by construction, so the gate is access
only — there is no production data to protect.

The site never runs tests itself: it renders a **result summary** produced by the existing
suites. This spec's chunk A defines that summary and guarantees it is emitted on every run.

## Chunks

- **A (PAY-43, this spec's §1–§3):** result emission — a versioned, PII-free JSON summary +
  the full HTML report, emitted on **every** run (pass and fail) across all suites. The single
  source of truth the site ingests. **This PR implements A only.**
- **B (PAY-44):** the static site core — ingest the summary, render overall status, run history,
  per-suite breakdown, report link. Published as `ghcr.io/soult-io/payroll-app-verify`.
- **C (PAY-45):** rich cards — per-journey e2e cards + tax-worksheet expected-vs-actual
  correctness/provenance cards.
- **D (PAY-46):** deploy — `verify` service in `nsoult-agentic/stack-payroll`, NPM host, gate.

---

## 1. The result summary (chunk A)

One versioned JSON document per run, assembled from the suites' own machine-readable reporter
output. It is the contract between the suites (producers) and the site build (consumer, chunk B).

### 1.1 Sources

| Suite key | Producer | Runner | Reporter |
| --- | --- | --- | --- |
| `engine` | `@payroll/engine` vitest (regression oracle, spec 2) | CI `verify` job | vitest `json` |
| `server` | `@payroll/server` vitest (integration + tax worksheets: 940/941 PDF, FUTA cap/credit, state taxes, filings, guards) | CI `verify` job | vitest `json` |
| `e2e` | `@payroll/e2e` Playwright journeys | CI `e2e` job **and** `e2e-nightly` (live QA) | Playwright `json` |

The tax-worksheet correctness fixtures are vitest tests inside `engine`/`server`; chunk A carries
their pass/fail. Their expected-vs-actual detail is surfaced by chunk C.

### 1.2 Schema (versioned)

`@payroll/verify-summary` owns the zod schema and the inferred types. Top level:

- `schemaVersion` — integer, bumped on any breaking field change (starts at `1`).
- `runId`, `source` (`ci` | `nightly`), `gitSha`, `gitRef`, `generatedAt` (ISO-8601 UTC).
- `overallStatus` (`passed` | `failed`) — `failed` if any suite failed or is missing.
- `counts` — `{ passed, failed, skipped, total }` summed across suites.
- `suites[]` — each `{ key, name, status, durationMs, counts, tests[] }`, where a test is
  `{ name, fullName, status (passed|failed|skipped), durationMs, file? }`.

The schema is the only import chunk B needs; it must stay backward-compatible within a
`schemaVersion`.

### 1.3 PII-free guarantee

The summary carries test names, file paths and durations — never payroll data. Because a stray
fixture string could still leak, chunk A ships a guard (`assertPiiFree`) that scans every string
value in the assembled summary against email / US-SSN / EIN / bank-routing / account-number /
phone patterns and **fails the build** if any match. Emission runs the guard before writing; a
unit test asserts the guard catches a planted value and passes clean synthetic input.

## 2. Emission — every run, pass and fail

Today both `ci.yml` (`e2e` job) and `e2e-nightly.yml` upload a Playwright report **only on
failure**, and nothing emits a machine-readable summary. Chunk A changes that:

- vitest (`engine`, `server`) and Playwright gain a `json` reporter writing to a stable path
  under a `verify-artifacts/` directory; existing console/GitHub/html reporters are kept.
- A CLI (`@payroll/verify-summary`) reads those reporter files + git/run metadata, builds the
  summary, runs the PII guard, and writes `verify-artifacts/summary.json`.
- CI: a `verify-summary` job (`needs: [verify, e2e]`, `if: always()`) downloads both jobs'
  reporter artifacts, builds the unified summary, and uploads `summary.json` + the HTML report as
  an artifact **on every run** (`if: always()`, not `if: failure()`).
- Nightly: the same emission runs inline in `e2e-nightly.yml`, always uploading `summary.json` +
  report (the nightly summary has only the `e2e` suite; `overallStatus` reflects that).

The **publish location** the site ingests from (GHCR layer vs a data branch vs pinned artifact)
is decided in chunk B; chunk A stops at a stable, named CI artifact.

**Note for chunk B:** the artifact also carries the Playwright **html report** (and, on failure,
`screenshot: only-on-failure` captures of the live QA UI). The §1.3 guard covers `summary.json`
only — not the html/screenshots. That is safe because QA is synthetic by construction (spec 14),
but chunk B's ingest must keep relying on that invariant (or scrub the report) before the site is
exposed, since the site is access-gated rather than public.

## 3. Out of scope for chunk A

The site, its image, the rich cards, and the deploy/gate — chunks B/C/D. Chunk A adds no runtime
surface to the app and no new container.
