# Spec 10 — 1099 Contractors (domestic & international)

Status: `DRAFT — awaiting owner sign-off` · Depends on: Spec 1 (data model), Spec 5 (documents), export API · Factual basis: `plan/research/contractors.md` · Activates: D10 (1099 invoicing future)

Scope: everything needed to onboard, pay, and year-end-report 1099 contractors — US-person
and non-US-resident — as first-class records alongside W-2 employees. Explicitly **not** in
scope: 1042-S/1042 generation (see §7), time-off, any change to the W-2 payroll engine.

## 1. Worker model

Reuse `employees` with `employment_type='1099'` (CHECK already permits it; admin create
endpoint already accepts it). Contractors never enter `payroll_runs` — the generator
already ignores them, and Spec 10 adds an explicit filter + test so a 1099 worker can
never produce a payroll draft even by accident.

New table — the classification & tax-forms layer:

```sql
contractor_details (               -- 1:1 with employees where employment_type='1099'
  id                  SERIAL PRIMARY KEY,
  employee_id         INTEGER NOT NULL UNIQUE REFERENCES employees(id),
  tax_status          TEXT NOT NULL CHECK (tax_status IN ('us_person','nonresident')),
                      -- status, NOT location: a US citizen abroad is still us_person
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('individual','entity')),
  residence_country   TEXT,          -- ISO-3166; required when tax_status='nonresident'
  tin                 TEXT,          -- SSN/EIN/foreign TIN; encrypted at rest like employees.tax_id
  tax_form            TEXT NOT NULL CHECK (tax_form IN ('w9','w8ben','w8ben_e','w8eci')),
  form_collected_at   DATE,          -- NULL = form outstanding (blocks payment, §4)
  form_expires_at     DATE,          -- w8ben/w8ben_e: collected_at + 3 calendar years; w9: NULL
  backup_withholding  BOOLEAN NOT NULL DEFAULT FALSE,
                      -- TRUE → withhold 24% (missing/incorrect TIN, IRS notice)
  services_location   TEXT NOT NULL DEFAULT 'foreign'
                      CHECK (services_location IN ('foreign','us','mixed')),
                      -- contractor's assertion of where work is physically performed
  us_days_log         JSONB NOT NULL DEFAULT '[]',
                      -- [{year, days, note}] — documentation for sourcing position;
                      -- presence of US days is what would trigger 1042-S review
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
)
```

History: edits to `contractor_details` go through the existing change-request machinery
(Spec 7) — same draft → comment thread → approve → effective-dated apply — with the
request type extended. W-8 renewal uses the same renewal-deadline + notification pattern
as `w4_elections.renewal_deadline`.

## 2. Money flow: invoices & payments

Contractors are paid against **invoices**, not periods. Two tables, deliberately separate
from `payroll_runs` (no snapshot, no engine, no payslip):

```sql
contractor_invoices (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  invoice_ref   TEXT,                -- contractor's own reference/number
  description   TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL DEFAULT 'USD',   -- v1: recorded as USD at payment
  invoice_date  DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted','approved','rejected','paid','void')),
  submitted_by  TEXT,                -- user.id if contractor self-submits; NULL if admin-entered
  reviewed_by   TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
)

contractor_payments (
  id                    SERIAL PRIMARY KEY,
  invoice_id            INTEGER NOT NULL UNIQUE REFERENCES contractor_invoices(id),
                        -- 1:1 in v1 (one payment settles one invoice)
  pay_date              DATE NOT NULL,
  amount                NUMERIC(12,2) NOT NULL,     -- USD actually paid
  exchange_rate         NUMERIC(12,6),              -- NULL if invoice already USD
  method                TEXT NOT NULL
                        CHECK (method IN ('ach','check','wire','card','third_party_network')),
                        -- card/third_party_network → EXCLUDED from 1099-NEC (processor
                        -- files 1099-K); drives year-end totals
  backup_withheld       NUMERIC(12,2) NOT NULL DEFAULT 0,
                        -- 24% of amount when contractor_details.backup_withholding
  reference             TEXT,          -- check #, wire ref, transaction id
  created_at            TIMESTAMPTZ DEFAULT now()
)
```

Workflow: invoice submitted → admin notified → approve/reject (with note) → admin records
payment → status `paid` → contractor notified. Status transitions are guarded server-side
(e.g., only `approved` → `paid`; `paid` is terminal except `void` with note).

## 3. Year-end: 1099-NEC on demand

- New dated config `contractor_reporting_config (tax_year, nec_threshold, …)` seeded with
  **$600 through 2025, $2,000 for 2026**, marked inflation-indexed from 2027 — admin-editable
  per year, same pattern as `tax_config`. Never a hardcoded constant.
- Admin "Year-end" action per tax year: per US-person contractor, sum **reportable**
  payments (`method NOT IN ('card','third_party_network')`) → if ≥ threshold, generate a
  **1099-NEC PDF on demand** (deterministic from stored payments; generated, not stored —
  same doctrine as payslips, D5). Box 1 = reportable total; box 4 = total
  `backup_withheld`. Payer fields from `company` (legal_name, ein, address).
- Below-threshold contractors listed with totals and an explicit "no form required"
  marker — the threshold decision is visible, never silent.
- Backup-withholding totals surfaced for the Form 945 reminder (filing itself out of scope).
- **State thresholds**: documented as divergent (some states still $600); V1 generates the
  federal form only, state note in docs.

## 4. Enforcement & guardrails

- **Payment gate**: admin cannot record a payment for a contractor whose
  `form_collected_at IS NULL` or whose form is expired — server-enforced, with a clear
  error naming the missing form. (W-9/W-8 on file before money moves.)
- **W-8 expiry**: `form_expires_at` approaching (30 days) → notification to admin + the
  "form outstanding" gate re-arms at expiry. Mirrors the W-4 renewal pattern.
- **`us_days_log` non-empty or `services_location='us'|'mixed'`** → year-end view flags
  "1042-S review required" instead of generating a 1099-NEC. Detection only; no 1042-S
  generation (§7).
- Payroll generator asserts `employment_type='w2'` per run — regression test included.

## 5. Export API extension

`GET /api/export/contractor-payments?year=YYYY` behind the existing read-only export token:
per contractor — id, legal_name, tax_status, entity_type, form status, payments (date,
amount, method, backup_withheld), reportable total, threshold, form-required flag. No TIN,
no bank, no address beyond company header. Feeds the Accountant agent's January 1099/945
package. Documented in docs/export-api.md.

## 6. UI

- Admin: Contractors section (list + detail) — classification form, document status with
  expiry countdown, invoice queue (approve/reject), payment recording, year-end tab.
- Contractor self-service: **deferred** — see D16. If accepted, contractors get the
  existing invite flow, a stripped portal (their invoices, submit new invoice, their
  year-end forms); if declined, admin enters everything (`submitted_by IS NULL`).
- Employee portal unchanged for W-2 users.

## 7. Explicit non-goals (V1)

- Form 1042-S / 1042 generation — flagged for review (§4) but not generated. Added when a
  real US-source case exists.
- Multi-currency payroll-style conversion accounting — amounts recorded in USD with the
  rate noted; FX gain/loss bookkeeping stays with the Accountant.
- 1099-MISC, 1099-K issuance, state 1099 filings, IRIS/FIRE e-file transmission (PDF only;
  transmission stays a manual/Accountant step).
- Misclassification enforcement — docs note the IRS behavioral/financial/relationship
  factors; the software does not police worker classification.

## 8. Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D13 | Worker model | Reuse `employees` + new `contractor_details` 1:1 (not a separate workers table) |
| D14 | Payments shape | Invoices + 1:1 payments, separate from `payroll_runs`; payment-method tracked for the 1099-K carve-out |
| D15 | Year-end | On-demand 1099-NEC PDF at dated threshold config ($2,000/2026, indexed); below-threshold visible; 1042-S detection-only |
| D16 | Contractor portal | **Deferred** — admin enters invoices in V1; portal reuses invite flow later. Confirm or pull into V1 |
| D17 | Payment gate | Hard server block on paying without a valid form on file (vs warn-only) |
| D18 | Export | Extend export token endpoint with contractor-payments (vs letting Accountant psql it) |

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
