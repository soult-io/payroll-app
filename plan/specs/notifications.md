# Spec 6 — Notifications (Email, D8)

Status: `DRAFT — awaiting owner sign-off` · Depends on: data-model, auth

## Transport

- **nodemailer over SMTP.** All connection parameters (host, port, user, pass, from-address,
  TLS mode) come from env/`/secrets/` files at deploy time — nothing infrastructure-specific
  in code (D8: reusable product).
- Sending uses the **outbox pattern**: business transactions insert into `email_outbox`;
  a pg-boss worker drains pending rows with exponential backoff (max 5 attempts, then
  `failed` + admin-visible). Email failure can never roll back a payroll or approval action.

## Event catalog (v1, per-event — no digests)

| event_type | Trigger | Recipients |
|---|---|---|
| `payroll_draft_ready` | Scheduler creates draft run(s) | all active admins |
| `payslip_issued` | Run approved → issued | that employee |
| `change_request_submitted` | Employee submits request | all active admins |
| `change_request_approved` | Admin approves | that employee |
| `change_request_denied` | Admin denies | that employee |
| `security_invite` | Admin invites user | invitee (always on — not toggleable) |
| `security_password_reset` | Reset requested | requester (always on) |
| `security_login_new_device`* | Login from unseen fingerprint | that user (always on) |

\* included because the app is internet-exposed with payroll PII; cheap to add, high value.

## Per-user settings (D8)

- `notification_settings` row per (user, event_type); toggleable rows are the five
  workflow events. Security events are always on (not listed in settings UI).
- Default: all enabled. Settings page shows per-event toggles (frontend spec).

## Templates

- MJML-free: plain HTML templates as TS string functions in `packages/notifications/templates/`,
  one per event, versioned with the repo. Branding = company name from the `company` row,
  no external assets. Every email has a text/plain fallback.
- Content rules: never include amounts in `change_request_*` emails; `payslip_issued`
  states period + "log in to view/download" (no net pay, no PDF attachment — links to app);
  bank/SSN data never appears in any email.

## Admin observability

- Admin settings page shows the outbox (pending/failed/sent counts, last error) and a
  "send test email" button. Failed sends surface as an in-app admin alert too.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
