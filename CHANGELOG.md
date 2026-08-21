# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
