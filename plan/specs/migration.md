# Spec 9 — Migration & Cutover

Status: `DRAFT — awaiting owner sign-off` · Depends on: all specs · Confirms: D4 (sole writer)

## What moves

One-time copy from `legacy_accounting.accounting` → new `payroll` database:

| Source (accounting schema) | Target | Notes |
|---|---|---|
| `employees` (1 row) | `company` + `employees` | company row synthesized ('Example Corp'); employment_type='w2' |
| `compensation` | `compensation` | monthly_salary → period_amount + frequency='monthly' |
| `w4_elections` | `w4_elections` | exempt election, effective_from 2026-04-01, renewal deadline preserved |
| `tax_config`, `tax_brackets` | same names (+jurisdiction='federal') | 2025 + 2026 rows verbatim |
| `payroll_runs` + `payroll_entries` | `payroll_runs` + `payroll_entries` | month/year → period_start/end/pay_date; status='issued'; **snapshot reconstructed** (below) |

NOT migrated: `time_off` (empty/future), `compliance_filings`, `deposits`, `pay_stub_path`
(files stay in the old file store as the archive — D5: no file migration, data only).

## Snapshot reconstruction (the delicate part)

Historical runs predate `run_snapshot`. For each imported run, the migration script
reconstructs the snapshot from the historical config that produced it (2025/2026 tax
config, seeded W-4, compensation schedule) and the stored entries as `result` — then
**validates**: recomputing the period through the vendored engine with those inputs must
reproduce the stored entries to the cent (same check as the engine's golden differential
test). Any run failing validation halts the migration for manual review rather than
importing a wrong snapshot. `engineVersion` recorded as `legacy-import`.

## Cutover sequence

1. Deploy app + DB with schema; run migration script (idempotent, dry-run mode first).
2. Verify: row counts, golden differential all green, one historical payslip PDF visually
   diffed against the file-store original.
3. Create admin user (CLI), invite the employee user, enroll TOTP.
4. **Sole-writer cutover (D4):** the app becomes the only writer for payroll data.
   - The old `accounting` payroll tables stay as read-only history (mcp-accounting's
     `accounting-payroll-calculate`/`paystub` tools remain functional against history but
     are no longer used).
   - The claude-code monthly payroll routine is retired: its final action is generating
     nothing — the app's scheduler takes over from the next period (first live run:
     next 15th after deploy, or manual "generate draft now").
5. Update agent docs (accountant AGENTS.md/STATE.md) to point at the app as source of truth.
6. 30-day rollback plan: old routine and the file-store archive remain intact; if the app fails,
   payroll falls back to the old MCP flow for that month.

## Post-cutover v1 checklist

- [ ] First scheduler-generated draft appears on the configured day (default 15th)
- [ ] Admin approves → issues; employee receives email; PDF downloads correctly
- [ ] Change request round-trip (submit → comment → approve → effective-dated apply)
- [ ] Old file-store archive untouched; agent routine confirmed silent

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
