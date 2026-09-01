# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-09-01

### Added

- Configurable per-year **FUTA SUTA credit rate** for the 940 worksheet
  (PAY-18): `tax_config.suta_credit_rate` (NUMERIC(6,5), default 0.054 = the
  full credit → 0.6% net) drives the Form 940 worksheet, so employers that
  paid no SUTA can set 0 and accrue the full statutory 6.0% ($420/employee on
  the $7,000 cap). Admins edit it under Configuration → Tax tables (audited
  `PUT /api/admin/tax-config`); the net rate is mirrored into `futa_rate` so
  payroll-run accrual, snapshots, and W-2s keep the existing code path, and
  the 940 filing detail now shows the rate assumption (6.0% − credit = net).
  Existing rows backfill to 0.054 — identical to current behavior.

## [1.10.0] - 2026-09-01

### Added

- Effective-dated employee **mailing address** on W-2 box f (PAY-20):
  employees gain an optional mailing address (`employees.mailing_address`),
  and W-2 box f now renders the address effective as of **Dec 31 of the tax
  year** — the mailing address first, falling back to the residential address
  effective at the same date. History resolves through approved
  change_requests (latest change with `effective_from <= as-of`, with the
  pre-first-change value recovered from the approve audit event).
- The mailing address joins the **change-request flow** (new
  `mailing_address` request type, one-pending-per-employee enforced) and
  **admin direct edit** (`PATCH /api/admin/employees/:id` with an optional
  effective-from date, recorded as an already-approved change request so both
  flows share one effective-dated history). Employee profile + request wizard
  and the admin employee detail screen expose the new field. Payslips are
  unchanged; exports stay PII-free.

### Fixed

- Change-request approvals with an effective-date **override** now persist
  the applied date onto the request row (the originally requested date is
  preserved in the audit event), so effective-dated resolution sees the date
  the change actually took effect.

## [1.9.0] - 2026-08-31

### Added

- Official IRS-form W-2/W-3 PDFs (PAY-19): the PAY-11 lookalike documents
  are replaced by the **official IRS AcroForm templates** (2025 revisions,
  bundled under `packages/documents/assets/forms/2025/` and SHA-256-pinned
  in a year registry), filled via a rect-verified field map and **flattened
  on render** so downloads are finished documents. The employee packet is
  one PDF — Copies B/C/2 plus the IRS Notice/Instructions pages (Pub 1141
  §3.1.05); the admin gets Copy D per employee for records, a print-ready
  employee packet, and the filled official W-3. Box d carries the employee
  ID; SSA filing stays manual via BSO (Copy A/1 are never emitted).
- Electronic-delivery consent flow (PAY-19, Pub 1141 §2.4): employees must
  affirmatively consent before their W-2 PDF is served — the consent
  endpoint furnishes the required disclosures (paper-copy right, withdrawal
  and consequences, PDF-reader requirement, Jan 31 → Oct 15 posting
  window), withdrawal re-gates the download immediately, and both actions
  are audited. The admin W-2 list shows per-employee delivery status and a
  consent-independent **print packet** route for paper furnishing.

## [1.8.0] - 2026-08-30

### Added

- Annual forms package (PAY-11): when a calendar year with issued payroll
  runs ends, the app computes a deterministic **Form 940 (FUTA) worksheet**
  from frozen issued-run entries — lines 3/7/8/12 with the per-employee
  $7,000 FUTA wage cap from the year's tax config, the frozen-entry
  accrued-liability truth reconciled to the cent via a documented rounding
  delta (941 line-7 doctrine), and the $500 quarterly deposit rule with the
  crossing quarter and due date. **W-2/W-3 generation**: per-employee W-2
  box figures (contractors excluded) and the W-3 transmittal aggregate, with
  on-demand PDFs rendered server-side — SSN/address/EIN decrypted at render
  time only, never persisted or exposed over JSON. W-2s become available to
  employees in **January of the following year** via self-service download on
  the payslips page, announced by a once-per-year `w2_available` email (year
  + log-in only, no amounts). Annual filings reuse the PAY-10 tax_filings
  infrastructure (no migration): refresh-unfiled-on-read, freeze-when-filed,
  due-date reminder emails, and mark-as-filed with per-form e-file help
  (IRS-authorized e-file for 940, SSA Business Services Online for W-2/W-3).

[1.8.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.8.0

## [1.7.0] - 2026-08-30

### Added

- Back navigation preserving list filter state (PAY-17): every detail page
  (filing, payroll run review, employee, contractor, request review/thread,
  payslip) now has a back arrow button in the header. List filters are
  encoded in the route query (`?year=`, `?status=`, `?form=`, `?tab=`) via a
  new `useQueryFilters` composable, so filtered lists are bookmarkable and
  browser-back restores them; lists pass their query onto detail URLs and
  the back button returns to the list with the same filters applied. Covers
  the admin filings / deposits / payroll runs / employees / contractors
  (incl. year-end tab) / requests lists and the employee payslips (year
  selector), invoices, and requests lists. The admin requests "All" filter
  is an explicit `?status=all` sentinel so it doesn't collide with the
  "pending" default.

[1.7.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.7.0

## [1.6.0] - 2026-08-29

### Added

- Quarterly Form 941 package (PAY-10): when a quarter with issued payroll
  runs ends, the app computes a deterministic line-by-line 941 worksheet
  from frozen issued-run entry snapshots (SHA-256 hashed; lines 1–16 incl.
  line 13 deposit reconciliation and the line 16 monthly liability
  breakdown with de minimis evaluation) and tracks the filing through
  ready → filed on a new admin "Tax filings" page. Mark-as-filed records
  date + method + reference (e.g. the Letterstream Job ID) with a "How to
  file" help dialog; filed worksheets freeze forever. Line 7 fractions of
  cents defaults to the computed rounding delta and is admin-editable while
  unfiled. First-class adjustment/notice records per filing (CP220-style
  notices, abatements, payments) feed line 13. Due-date reminder emails
  (`tax_filing_due`) on an admin-configurable offset schedule (default
  14/7/0 days). Record-only: filing still happens by mail or e-file.

[1.6.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.6.0

## [1.5.0] - 2026-08-28

### Added

- Tax deposits year paging + status filter (PAY-15): the admin Tax
  Deposits page now pages by year (options derived from the data, current
  year included even with no rows) and filters by status
  (pending/deposited/overdue), matching the payroll-runs list. The list
  endpoint accepts optional `year` and `status` query params.

[1.5.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.5.0

## [1.4.0] - 2026-08-26

### Added

- Current-month tax deposit rows (PAY-14): the Tax Deposits page now shows
  the current month's deposit as soon as a payroll run issues in it,
  instead of waiting for the month to close. Due dates, overdue marking,
  and reminder emails stay relative to the 15th of the following month, so
  a current-month row is never overdue and never reminds, and a deposit
  recorded early (e.g. paid the day payroll runs) is never rewritten by
  later recomputation.

[1.4.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.4.0

## [1.3.0] - 2026-08-25

### Added

- Monthly federal tax deposits (PAY-9): the app now computes each month's
  941 deposit (employee federal withholding + both sides of Social Security
  and Medicare, from issued-run snapshots — deterministic to the cent),
  schedules it for the 15th of the following month with weekend roll, and
  tracks it through pending → deposited/overdue on a new admin "Tax
  deposits" page with a mark-as-deposited action (date + EFTPS confirmation
  number). A daily scheduler tick syncs the computed schedule and emails
  due-date reminders on an admin-configurable offset schedule (default: 5
  days before + on the due date) via the new admin-only `tax_deposit_due`
  notification event. The schema is jurisdiction-ready for state deposits
  (PAY-13). Record-only: payments still happen on eftps.gov.

[1.3.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.3.0

## [1.2.0] - 2026-08-21

### Added

- Session-expiry redirect (PAY-6): an expired or revoked session now
  redirects straight to the login page (preserving the attempted path for
  post-login return) instead of surfacing error toasts from in-flight API
  calls. Both API clients report unexpected 401s through a single
  session-expired hook; onboarding and pre-auth flows are unaffected.

[1.2.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.2.0

## [1.1.0] - 2026-08-21

### Added

- Role- and worker-type-scoped UI (PAY-8): the nav shows Payslips only to
  W-2 employees and Invoices only to contractors, with matching route guards
  (a wrong-type direct URL redirects to the dashboard). Notification settings
  are scoped by a new per-event audience declaration (`EVENT_AUDIENCE`):
  non-admins no longer see or set admin-only events, and worker-type events
  only surface for the matching type. `PUT /api/my/notification-settings`
  rejects out-of-audience events with `not_applicable`.

### Fixed

- Live-QA e2e: `loginAs` waits out the credential rate-limit window (429
  rendered as "Invalid email or password") and retries, fixing the flaky
  `#totp` login failures in the nightly suite.

[1.1.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.1.0

## [1.0.3] - 2026-08-21

### Fixed

- Reverted primevue 5.0 → 4.5.x and @primeuix/themes 3.0 → 2.0.x: PrimeVue 5
  left MIT for the commercial PrimeUI license and bundles
  `@primeui/license-manager`, which showed an "invalid PrimeUI license"
  notice to end users. dependabot now ignores primevue and `@primeuix/*`
  semver-major updates so this cannot regress.

[1.0.3]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.3

## [1.0.2] - 2026-08-21

### Added

- Contractor self-service **My Invoices** (PAY-7): contractors see their own
  invoices like W-2 employees see payslips — a year-grouped `/my/invoices`
  page (approved + paid invoices only, per D1), with status chips, per-year
  paid/pending totals, and an on-demand invoice PDF per row (never stored).
  New endpoints: `GET /api/my/invoices` (with the 1:1 payment join) and
  `GET /api/my/invoices/:id/pdf` (404 on foreign or hidden invoices).
- The contractor-facing invoice lifecycle emails (invoice reviewed / invoice
  paid) are now user-toggleable in notification settings (D3).
- QA seed: the Dave Placeholder contractor persona has a portal login for
  self-service e2e (documented in docs/qa.md).

### Fixed

- `create-contractor-template` CLI accepts the documented kebab-case flags
  (`--pay-day`, `--starts-on`, …) in addition to camelCase.

[1.0.2]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.2

## [1.0.1] - 2026-08-20

Maintenance release: dependency updates across the board. No functional
changes.

### Changed

- Production dependencies: primevue 4.5 → 5.0 (with strictly typed form
  fields for the new InputNumber API), @primeuix/themes 3.0, pinia 4.0,
  vue-router 5.2, pino 10, drizzle-orm 0.45, fastify 5.12, better-auth
  1.6.29, zod 4.4.3, pg 8.23, nodemailer 9.0.5, pg-boss 12.27, and others.
- Dev dependencies: vite 8.2, vitest 4.1, @playwright/test 1.62.1,
  @types/node 26 (with explicit `types: ["node"]` in the affected packages),
  tsx 4.23, vue-tsc 3.3.
- GitHub Actions: pnpm/action-setup 6, upload-artifact 7,
  build-push-action 7, login-action 4, github-script 9.
- TypeScript intentionally held at 5.9.x (5.9.3); dependabot is configured
  to ignore TypeScript semver-major bumps until the toolchain is ready.

[1.0.1]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.1

## [1.0.0] - 2026-08-19

First public release.

### Payroll core

- Monthly payroll lifecycle: scheduled draft generation (configurable pay
  schedule, default monthly on the 15th), admin approval, issue and void.
- Deterministic calculation engine (`@payroll/engine`): federal withholding
  from yearly bracket tables, Social Security, Medicare, employer-side taxes;
  every issued run carries an immutable, hash-verified input snapshot.
- Payslips: generated on demand as PDF (the database is the source of truth —
  no stored files), grouped per year, with per-category YTD totals (gross,
  federal withholding, Social Security, Medicare, net).
- Effective-dated compensation and W-4 elections, including exempt status.

### Contractors (1099 / non-US)

- Domestic 1099-NEC contractors and nonresident contractors (W-8BEN on file,
  expiry tracking, no US-source withholding), with entity types.
- Contractor payments: record, void, per-year totals against the reporting
  threshold; 1042 review flag for edge cases.
- Recurring contractor payment scheduler — the contractor analogue of the
  W-2 payroll scheduler (draft → approve → record).

### Self-service & admin

- Auth with invite-only registration, TOTP second factor, role-based access
  (admin / employee).
- Employee self-service: payslip history + PDF download, profile view, change
  requests (address, legal name, bank details, W-4 elections, TIN) with
  effective dating and threaded admin review (approve / deny).
- Admin configuration: employees, compensation, W-4 elections, tax brackets
  per year, pay schedule, company details (incl. EIN, encrypted at rest),
  users and invites, audit views.
- Notification outbox with per-event SMTP email settings (new payslip,
  change-request events, payroll lifecycle events).

### Integrations & operations

- Read-only export API (`/api/export/…`) for issued payroll runs and
  contractor payments, gated by a scoped service token — built for unattended
  downstream consumers (tax deposit and filing workflows); exports contain no
  surplus PII.
- One-time legacy migration CLI: imports payroll history from a legacy
  accounting schema with snapshot reconstruction validated to the cent before
  any write; dry-run by default, idempotent `--write`.
- Single self-contained container image (`ghcr.io/soult-io/payroll-app`);
  secrets read as files from `SECRETS_DIR`; Postgres 16 via Drizzle
  migrations; reference deployment in `compose.example.yml`.

### Quality gates

- CI: lint/format (Biome), build, typecheck, engine unit tests (regression
  oracle) and server integration tests (PGlite), end-to-end Playwright suite
  gating every image push; Trivy CRITICAL gate on the published image;
  CodeQL.
- Nightly e2e against a live QA deployment (self-hosted runner inside the QA
  network), with failures filed as deduplicated GitHub issues.

[1.0.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.0
