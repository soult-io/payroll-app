# Spec 2 — Payroll Engine

Status: `DRAFT — awaiting owner sign-off` · Depends on: data-model · Feeds: documents, notifications

## Core principle

The calculation engine is **the existing tested code, reused verbatim**:
`stack-finance/mcp-accounting/src/payroll.ts` + `money.ts` are vendored into the new repo as
`packages/engine/` (MIT, own code) with their unit tests. The engine stays **pure and
deterministic**: fully-resolved inputs in, `PayrollResult` out, zero I/O.

## Extensions to the vendored engine (small, additive)

1. **Frequency generalization.** Today: `monthlySalary * 12` annualization. New input
   `periodsPerYear` (52/26/24/12) derived from `compensation.frequency`; annualization becomes
   `periodAmount * periodsPerYear` and withholding de-annualizes by the same factor.
   Monthly behavior must remain bit-identical to today (periodsPerYear=12).
2. **W-4 fields beyond exempt.** The 2020+ W-4 inputs (`dependents_amount`, `other_income`,
   `deductions_amount`, `extra_withholding`, `filing_status`) enter the annualized-tax
   computation per IRS Pub 15-T (annual wage method): adjust annual taxable by
   `deductions_amount − other_income`, subtract dependent credits after bracket computation,
   add `extra_withholding` per period. `federal_exempt` still short-circuits to $0.
   v1 behavior for the sole employee is unchanged (exempt, all other fields 0) — the fields
   exist and are unit-tested against Pub 15-T worksheets.
3. **Filing-status bracket sets.** `tax_brackets` gains rows per filing status via
   `jurisdiction` = `federal:single`, `federal:married_joint`, etc. (fits the existing
   jurisdiction column; seed = single, matching today).

## Run lifecycle (D6)

```
scheduler (pg-boss cron, per pay_schedules, default day=15)
  → for each active employee with auto_draft:
      resolve compensation as of period_start → resolve w4 election effective on period_start
      → resolve tax_config+brackets for period year → prior-YTD = SUM(entries) of issued runs
      → engine.calculate(...) → INSERT payroll_runs(status='awaiting_approval', run_snapshot)
        + payroll_entries, one transaction
      → notification: payroll_draft_ready → all admin users
admin reviews in UI → approve (status='approved', approved_by/at, audit event)
                   → issue   (status='issued', issued_at, snapshot frozen)
                   → notification: payslip_issued → employee
admin may void a pre-issued run (status='void', reason) — regenerating creates a NEW run row
```

- **Idempotency:** `UNIQUE(employee_id, period_start)` + pg-boss `singletonKey` per
  (employee, period). A retried scheduler tick can never double-issue.
- **Snapshot contract:** `run_snapshot` = `{ inputs: {periodAmount, frequency, w4, taxConfig,
  brackets, priorYtdGross}, result: PayrollResult, engineVersion }`. Documents spec renders
  PDFs from this alone. `engineVersion` (semver of packages/engine) records what computed it.
- **Config resolution is temporal:** every lookup is "row effective on the pay date",
  inside the run transaction. Edits to salary/tax tables never mutate existing runs.
- **Schedule management:** admin edits `pay_schedules` (day-of-month, frequency, auto_draft
  toggle); pg-boss cron re-registers on boot and on settings change. Manual "generate draft
  now" button for off-cycle runs (bonus corrections etc.).
- **Prior-YTD rule preserved:** YTD = SUM of `payroll_entries` from issued runs, never
  wage × period count (drives SS wage-cap, additional Medicare, FUTA base).

## Testing

- Vendor existing unit tests unchanged — they are the regression oracle.
- New: Pub 15-T worked examples for each W-4 field; property-based tests (fast-check) over
  bracket edges, wage-cap boundaries, rounding; golden-file differential test: 2025–2026
  real runs (from migration data) recomputed must match issued-history amounts to the cent
  (the 2025 stub federal $250.13 case is already encoded in existing tests).

## Out of scope (v1)

Payments, garnishments, benefits/401(k) deductions, state income tax beyond the existing
rate-scalar (schema-ready), 1099 contractor payments (D10).

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
