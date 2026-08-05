# QA environment runbook (spec 14)

A permanent, disposable-data QA deployment for clicking through features and
as a live target for the nightly end-to-end suite. **All data is synthetic
and re-seedable; no production data ever lands here.**

## Topology

- `payroll-qa` app container — same image as prod (auto-bumped pin per
  spec 13), `APP_ENV=qa`, served at `https://payroll-qa.stabpablo.eu`.
- `payroll-qa-db` — own postgres:16-alpine container + volume; fully
  self-contained, never connected to the prod DB.
- Mailpit — the app's only SMTP target in QA (captures all outbound mail; web
  UI internal-only). No external SMTP credentials exist in QA: real email
  cannot leave the network by construction.
- Migrate one-shot runs on every redeploy (same as prod); `seed:qa` is a
  manual CLI step after first boot (idempotent).
- Both schedulers ENABLED (payroll + contractor recurring) — scheduled
  behavior is exactly what QA exists to exercise.
- Separate secrets dir `/srv/payroll-qa/secrets` (db password, encryption
  key, session secret, export token — all distinct from prod values). **No
  `smtp-password`** — Mailpit takes no credentials and the app no longer
  requires the file when `SMTP_USER` is unset.

The compose/stack side lives in the stack repo (`nsoult-agentic/stack-payroll`,
`qa/` path) and must set these app env vars:

| Env var | QA value | Notes |
| --- | --- | --- |
| `APP_ENV` | `qa` | enables the banner + `/api/qa/mailbox` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` | `mailpit` / `1025` / any address | no `SMTP_USER` → no SMTP auth |
| `MAILPIT_URL` | `http://mailpit:8025` | Mailpit HTTP API for the mailbox endpoint |

## Seeding / re-seeding

```sh
# After first boot (migrations already ran via the one-shot):
docker exec payroll-qa node dist/cli/seed-qa.js
```

Idempotent — safe to re-run any time (existence checks / `onConflictDoNothing`
throughout; a re-run creates nothing twice). To **wipe and start over**:

```sh
docker compose -f qa/docker-compose.yml down -v   # drops the QA db volume
docker compose -f qa/docker-compose.yml up -d     # migrate one-shot re-runs
docker exec payroll-qa node dist/cli/seed-qa.js
```

## Fixed QA credentials (FAKE — QA-only, safe to publish)

| Account | Email | Password | TOTP |
| --- | --- | --- | --- |
| Admin | `qa-admin@example.test` | `qa-admin-passphrase-742` | raw: `QAADMIN0FIXED1TOTP2SECRET3SEED456` |
| Employee | `qa-employee@example.test` | `qa-employee-passphrase-318` | raw: `QAEMPLOYEE0FIXED1TOTP2SECRET3SEED` |

The **raw** TOTP secrets are what the app stores (and what
`@better-auth/utils`' `createOTP(secret).totp()` computes codes from — the e2e
suite uses these directly). For authenticator apps, the base32-encoded forms
are:

- admin: `KFAUCRCNJFHDARSJLBCUIMKUJ5KFAMSTIVBVERKUGNJUKRKEGQ2TM===`
- employee: `KFAUKTKQJRHVSRKFGBDESWCFIQYVIT2UKAZFGRKDKJCVIM2TIVCUI===`

Both accounts are fully enrolled (password + TOTP verified, workflow
notification defaults on). No backup codes are seeded.

## Persona inventory

**W-2 employees** (payroll history: previous calendar year in full + current
year through last month, issued through the real draft→approve→issue pipeline
— figures are engine-exact to the cent):

| Persona | State | Persona coverage |
| --- | --- | --- |
| Ada Testworth | IL | W-4 exempt (zero federal withholding); the ONE current-period draft run awaiting approval is hers |
| Bob Fakeley | TX | mid-year salary change — two compensation rows ($3,800 → $4,200 effective July 1 of the current year) |
| Carol Mockington | WA | pending address change request with a 3-comment thread; carries the `qa-employee` login |

**Contractors (1099):**

| Persona | Coverage |
| --- | --- |
| Dave Placeholder (US, W-9) | monthly $800 paid invoices this year — above the NEC threshold from March on (form required); recurring retainer template + one approved-but-unpaid generated invoice for the previous period (payment-due reminder fodder) |
| Erin Sampleton (US, W-9) | below the NEC threshold; backup withholding ON (24% withheld on her $400 payment); recurring template |
| Frida Nullstadt (DE, W-8BEN) | clean W-8BEN — `form_required=false`, not expiring (valid through (collected+3)-12-31); recurring template |
| Gustav Testenberg (SE, W-8BEN) | `us_days_log` entries → 1042-S review flag; W-8 expiring 20 days after seed date — inside the 30-day renewal-notification window (manual `form_expires_at` override; the app rule would always yield a Dec-31 expiry) |

## QA-only surfaces in the app

- **Banner** — `GET /api/runtime-config` (unauthenticated, returns only
  `{ appEnv }`) drives the persistent "QA — synthetic data" banner on every
  page incl. login when `APP_ENV=qa`.
- **Mailbox** — `GET /api/qa/mailbox?to=<address>&latest=true` exists **only**
  under `APP_ENV=qa` (404 elsewhere), is gated by the same export-token
  bearer credential as the export API, and proxies Mailpit
  (`MAILPIT_URL`) returning `{ subject, from, to, date, text, html }` of the
  latest matching message.

## Nightly e2e

`.github/workflows/e2e-nightly.yml` runs the Playwright suite at `17 5 * * *`
UTC (plus `workflow_dispatch`) against `https://payroll-qa.stabpablo.eu`
(`E2E_BASE_URL` disables the ephemeral boot; fixture journeys skip, the
`qa.spec` specs run read-only against the seeded data). Required GitHub
secret: **`E2E_QA_EXPORT_TOKEN`** — the value of the QA stack's
`/srv/payroll-qa/secrets/export-token` file (used for the mailbox endpoint).
On failure (scheduled runs only) it opens or comments on an open issue
labelled `e2e-nightly` instead of spamming duplicates.

To run the suite against live QA by hand:

```sh
E2E_BASE_URL=https://payroll-qa.stabpablo.eu \
E2E_QA_EXPORT_TOKEN=<qa export token> \
pnpm --filter @payroll/e2e e2e
```
