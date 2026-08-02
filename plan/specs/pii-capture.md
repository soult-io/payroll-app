# Spec 11 — PII capture: company EIN + employee TIN

Status: `APPROVED 2026-08-03 — implemented` · Depends on: Spec 1, Spec 4 (change requests), Spec 7 (admin) · Amends: interview answer E10 ("tax ID never changes — don't support it"), reversed by owner 2026-08-03 because initial values were never captured

Two small write paths for sensitive identifiers that were never backfilled after cutover.
Both reuse the existing app-level field encryption (`crypto/field-encryption.ts`, the
`bank_details`/`tax_id`/`company.ein` pattern) and the masked-display rule (`••••last4`).

## 1. Company EIN — admin-editable

- `PUT /api/admin/company` gains an optional `ein` field: validated against the IRS
  format `^\d{2}-?\d{7}$` (normalized to `XX-XXXXXXX` before storage), encrypted at rest,
  write-only — reads keep returning `einMasked`.
- Audit event records the change with **masked** before/after values only.
- Admin company settings UI: EIN becomes an editable field (shows masked current value,
  "set" state when NULL), replacing the "change requires a config update" note.
- Export API + 1099-NEC payer block pick it up automatically (both already decrypt
  `company.ein` — currently emitting `null`).

## 2. Employee TIN — two paths

**(a) Admin direct set** — the admin employee edit endpoint gains an optional `taxId`
(same validation + encryption as the create path, which already supports it). Purpose:
initial backfill and corrections. Masked on all reads; never in the directory API
(existing behavior preserved).

**(b) Employee change request** — new request type `'tax_id'` so the employee can submit
their own TIN for admin approval, like every other personal-data field:

- Migration widens the `change_requests_type_check` CHECK to include `'tax_id'`.
- The TIN inside `payload` is **encrypted at rest** (same field-encryption; the JSONB
  stores only ciphertext). No plaintext TIN ever touches `change_requests`,
  `change_request_comments`, `audit_events`, or notification payloads.
- Admin review UI shows the proposed value masked (`••••1234`) with a reveal-on-demand
  control; approve applies it to `employees.tax_id` effective-dated like other types;
  deny/withdraw leaves the record untouched.
- The one-pending-request-per-field partial unique index covers it automatically.
- Comment threads work unchanged (comments are free text; the value itself is never
  rendered into them by the app).

## 3. Non-goals

- No TIN history table (current value + change-request trail is the history).
- No SSN validation against SSA (format check only).
- Contractor TIN: already shipped in Spec 10 (admin-editable, encrypted, write-only).

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D19 | EIN edit path | Admin edits EIN in company settings (encrypted, masked audit), no approval loop — admin is the approver |
| D20 | Employee TIN paths | Both: admin direct set (backfill) **and** employee `'tax_id'` change request with encrypted payload + masked review |
| D21 | TIN visibility in review | Masked by default with explicit admin reveal control (vs always-masked) |

## Owner sign-off

- [x] Approved as written — 2026-08-03
- [ ] Approved with changes (list):
