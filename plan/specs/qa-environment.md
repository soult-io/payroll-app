# Spec 14 — QA environment

Status: `APPROVED 2026-08-03 — approved as written` · Depends on: Spec 13 (stack repo, QA compose path, auto pin-bot)

A permanent, disposable-data QA deployment for clicking through features (incl. ones the
owner doesn't use in prod), plus a live target for real end-to-end tests. Lives in
`nsoult-agentic/stack-payroll` at `qa/docker-compose.yml` as its own Portainer stack.

## 1. Topology

- `payroll-qa` app container — same image as prod (QA pin auto-bumped per Spec 13),
  `APP_ENV=qa`, `payroll-qa.stabpablo.eu` via NPM.
- `payroll-qa-db` — own postgres:16-alpine container + volume. Fully self-contained;
  no connection to prod DB ever.
- **Mailpit** container — the app's only SMTP target in QA. Captures all outbound mail
  (web UI on the internal network / tailnet only). **No external SMTP credentials exist
  in QA** — real email cannot leave the network by construction.
- Migrate one-shot runs on every redeploy (same as prod); `seed:qa` is a manual CLI
  step after first boot (idempotent, `onConflictDoNothing` style like existing seed).
- Both schedulers ENABLED (payroll + contractor recurring) — scheduled behavior is
  exactly what QA exists to exercise.
- Separate secrets dir `/srv/payroll-qa/secrets` (db password, encryption key, session
  secret, export token — all distinct from prod values).
- **QA banner**: when `APP_ENV=qa` the web UI shows a persistent colored banner
  ("QA — synthetic data") so prod/QA are never confusable in a screenshot.

## 2. Synthetic seed (`seed:qa` CLI in the app repo)

Deterministic, obviously-fake dataset (names like "Ada Testworth"); **no production data
is ever copied** (PII discipline). Personas chosen to cover the feature surface:

- 3 W-2 employees: varied states, one W-4 exempt, one mid-year salary change, one with
  pending change requests + comment thread
- 2 domestic 1099 contractors: one above NEC threshold (form required), one below;
  one with backup withholding on
- 2 international contractors: one clean W-8BEN (form_required=false), one with
  `us_days_log` entries (1042-S review flag) and an expiring W-8 (renewal notification)
- 2 years of issued payroll history across employees; one draft run awaiting approval;
  recurring invoice templates incl. one approved-but-unpaid (payment-due reminder)
- QA admin + employee logins with documented fixed credentials (QA-only)

## 3. E2E against live QA

- The existing Playwright e2e package gains `E2E_BASE_URL` targeting; default stays
  ephemeral-in-CI, optional target `https://payroll-qa.stabpablo.eu`.
- **Nightly CI job** runs the e2e suite against live QA (real Postgres, pg-boss,
  schedulers, Mailpit); failures open a GitHub issue automatically.
- New e2e specs added for the surfaces unit tests can't reach: scheduler tick → draft
  generation, email capture in Mailpit, full login + TOTP flow (QA TOTP secret from the
  QA seed), PDF download round-trip.

## 4. Explicit non-goals

- No prod data restore into QA, ever. QA data is synthetic and re-seedable.
- No QA→prod promotion mechanism; code flows main→release, not data.
- QA is not a performance/load environment.

## Amendment 2026-08-06 — self-hosted runner (approved: repo-scoped)

- `payroll-qa.stabpablo.eu` is scoped behind the NPM access list (LAN/tailnet
  only, like the MCP servers) — owner decision: QA is never publicly
  reachable. GitHub-hosted runners get 403, so `e2e-nightly.yml` runs on a
  **repo-scoped self-hosted runner on FRAME-DESK** (label `qa-e2e`; second
  runner instance alongside the embara-android one, SB #2115). Playwright
  system libs are pre-installed on the host (one-time); the workflow uses
  `playwright install chromium` without `--with-deps`.
- If FRAME-DESK is asleep at cron time the job queues (24h window) and runs
  on wake — accepted behavior for e2e.
- The QA export token is a FIXED DOCUMENTED value (docs/qa.md), not a GitHub
  secret — the app repo holds no repo secrets (owner 2026-08-06). The QA
  stack's `export-token` file must contain exactly that value.
- Public-repo caveat for later: before `soult-io/payroll-app` ever flips
  public, fork-PR workflow approval must be "all outside collaborators" (the
  nightly is schedule-only on self-hosted, so exposure is minimal — but set
  the guardrail first).

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D30 | QA = own stack in stack-payroll (`qa/` path), own DB, Mailpit-only email, APP_ENV banner | as above |
| D31 | Synthetic-only deterministic seed, never prod data | as above |
| D32 | E2E nightly against live QA + failure→issue automation | as above |

## Owner sign-off

- [x] Approved as written — 2026-08-03
- [ ] Approved with changes (list):
