# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
