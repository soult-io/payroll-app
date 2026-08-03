# Spec 12 — Recurring contractor invoices

Status: `APPROVED 2026-08-03 — implemented` · Depends on: Spec 10 (contractors), Spec 2 (scheduler pattern), Spec 6 (notifications) · Owner request 2026-08-03

The W-2 side has a scheduler that generates a monthly payroll **draft** → admin approves →
issued. Contractors get the same shape: a recurring template that generates an **invoice**
each period → admin approves → admin records the payment when the money actually moves.
Payments are never auto-recorded — a bank transfer is a real-world event the app can only
witness, so "record payment" always stays a deliberate admin act.

## 1. Template

```sql
contractor_recurring_invoices (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),   -- 1099 only, enforced
  description     TEXT NOT NULL,                                -- e.g. 'Monthly retainer — {month}'
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  invoice_day     TEXT NOT NULL DEFAULT 'last_day'
                  CHECK (invoice_day IN ('last_day','fixed')),  -- when the invoice is dated
  invoice_day_of_month INTEGER CHECK (invoice_day_of_month BETWEEN 1 AND 28),
                  -- required when invoice_day='fixed'; capped at 28, no Feb edge cases
  pay_day_of_month     INTEGER NOT NULL CHECK (pay_day_of_month BETWEEN 1 AND 28),
                  -- day of the FOLLOWING month the payment is due (Lucy: 11)
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  starts_on       DATE NOT NULL,        -- first period to generate for
  ends_on         DATE,                 -- contract end; NULL = open-ended
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
)
```

Edit semantics (mirrors compensation effective-dating in spirit, simpler in practice):
editing a template changes **future generations only** — invoices already generated are
untouched. Pause = `active=false` (keeps history, generates nothing). End = `ends_on`
(last period generated, then the template retires itself). Deleting a template is
allowed only before its first generation; afterwards it's pause/end only (audit trail).

## 2. Generation

- A **separate scheduler** for contractor invoices — same infrastructure and pattern as
  the W-2 payroll scheduler, but its own module, registration, and tick, registered
  independently of the payroll scheduler (owner direction 2026-08-03: "like the W-2
  scheduler, but different, since this is for contractors"). It can be inspected,
  logged, and if ever needed disabled without touching payroll generation.
- Its daily tick: for each active template whose period invoice date is **today**,
  generate one invoice.
- Generated invoice: `invoice_date` per template rule (last day of month, or fixed day),
  `description` with `{month}`/`{year}` interpolated, `amount`/`currency` from template,
  `submitted_by = NULL`, **status = 'submitted'** — it lands in the normal approval queue
  like any invoice. Nothing else special about it; the rest of the workflow is Spec 10.
- **Idempotent**: unique partial index on (template-generated) invoices per
  (template_id, period) — a re-run or double tick can never duplicate. Generation is
  recorded on the template (`last_generated_period`) as a second guard.
- Admin notification on generation: "Recurring invoice for Lucy — $2,000, July 2026 —
  awaiting approval" (same outbox/pg-boss machinery as payroll-draft notifications).

## 3. Payment-due reminder

On the template's `pay_day_of_month` (of the month following the invoice period), if the
generated invoice is approved but has no payment recorded → admin notification:
"Payment due today: Lucy — $2,000 (July retainer)". One per invoice per day, idempotent
via outbox markers (same pattern as the W-8 expiry sweep). If the payment is recorded
early, the reminder never fires. This replaces any external reminder setup.

## 4. UI (admin)

Contractor detail gains a "Recurring" section: template list (amount, schedule, next
generation, active/paused), create/edit/pause/end. Generated invoices appear in the
ordinary invoice queue with a small "recurring" marker (template id on the invoice row,
nullable — manual invoices unaffected).

Schema change to `contractor_invoices`: add nullable
`recurring_template_id INTEGER REFERENCES contractor_recurring_invoices(id)` +
the idempotency index. Additive migration only.

## 5. Explicit non-goals

- No auto-recording of payments (real-world money movement stays manual, forever).
- No variable-amount/templates-with-formulas (hourly × rate etc.) — fixed amount only;
  amount changes are a template edit.
- No contractor-facing visibility (portal is D16-deferred anyway).
- No payroll_engine involvement; this is invoice generation only.

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D22 | Generated invoices arrive as **'submitted'** requiring admin approval (vs auto-approved draft) — mirrors the W-2 draft→approve control | submitted |
| D23 | Payment-due reminder notification on the configured pay day if approved-but-unpaid — absorbs the standalone reminder idea | yes, built in |
| D24 | Schedule model: invoice dated last-day-of-month **or** fixed day (≤28); payment due on a fixed day (≤28) of the following month | as schema above |
| D25 | Template edits affect future generations only; pause/end instead of delete once used | as above |

## Owner sign-off

- [x] Approved as written — 2026-08-03, with separate-scheduler amendment
- [ ] Approved with changes (list):
