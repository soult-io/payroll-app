# Payroll Export API (read-only)

Read-only export of **issued** payroll figures for downstream compliance
work — 941 federal deposits, the quarterly/annual tax package
(941/940/W-2/W-3), compliance tracking. Activated 2026-07-30 per the
Accountant agent's request (D10 export capability, read-only form).

- **Read-only.** Never mutates payroll data. The app remains the sole writer
  (D4); this endpoint only SELECTs (plus one `audit_events` row per call).
- **Deterministic.** Figures come from the stored `payroll_entries` of
  issued runs — the validated, frozen truth. Identical request → identical
  bytes. No timestamps in the payload.
- **No surplus PII.** The payload carries the company header required for
  filings (`legal_name`, `ein`) and per-run figures. Employee SSN
  (`tax_id`), bank details, and addresses are never included.
- **Audited.** Every successful call writes an `audit_events` row
  (`actor_id=service:export`, `action=export.payroll_runs`, range, format,
  run count).

## Auth

Scoped service credential, unattended-callable (no interactive TOTP):

```
Authorization: Bearer <token>
```

The token lives at `$SECRETS_DIR/export-token` on the app container
(`/run/secrets` pattern, same as `db-password`). If the file is absent the
endpoint is **disabled** and returns `503 export_disabled` — deploying the
credential is an explicit decision. Wrong/missing token → `401`.

Generate and deploy (on the NUC):

```
openssl rand -hex 32 | sudo tee /srv/payroll/secrets/export-token
# stack redeploy picks it up (secrets dir is already mounted)
```

## Endpoint

```
GET /api/export/payroll-runs?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv
```

| Param    | Default  | Notes                                                        |
| -------- | -------- | ------------------------------------------------------------ |
| `from`   | (none)   | Inclusive lower bound on **pay_date**                        |
| `to`     | (none)   | Inclusive upper bound on **pay_date**                        |
| `status` | `issued` | Only `issued` is accepted — draft/void are not authoritative |
| `format` | `json`   | `json` or `csv`                                              |

The range keys on **pay_date**, not period dates: deposits and filings are
keyed on when wages were *paid*.

### JSON response

```json
{
  "company": { "legalName": "SOULT IO LTD", "ein": "12-3456789" },
  "status": "issued",
  "range": { "from": "2026-01-01", "to": "2026-03-31" },
  "runs": [
    {
      "employeeId": 1,
      "periodStart": "2026-01-01",
      "periodEnd": "2026-01-31",
      "payDate": "2026-01-15",
      "status": "issued",
      "snapshotHash": "<sha256 of the frozen run snapshot>",
      "entries": {
        "gross_pay": "3500.00",
        "federal_withholding": "250.13",
        "social_security": "217.00",
        "medicare": "50.75",
        "state_withholding": "0.00",
        "net_pay": "2982.12",
        "employer_social_security": "217.00",
        "employer_medicare": "50.75",
        "employer_futa": "21.00"
      }
    }
  ]
}
```

- All amounts are **strings to the cent** — parse as decimal, never float.
- `ein` is decrypted at read; `null` until configured in admin settings.
- A missing entry category is `null`, never silently `"0.00"` — treat any
  `null` as data corruption and alert.

### CSV response (`format=csv`)

One header row + one row per issued run, columns:

```
employee_id,period_start,period_end,pay_date,status,snapshot_hash,gross_pay,federal_withholding,social_security,medicare,state_withholding,net_pay,employer_social_security,employer_medicare,employer_futa
```

The company header is JSON-only; CSV consumers key on one known company.

## Aggregation recipes (Accountant)

- **Monthly 941 deposit** for month M (`from=YYYY-MM-01&to=YYYY-MM-<last>`):
  per run, `federal_withholding + social_security + medicare +
  employer_social_security + employer_medicare`; sum across runs.
- **Quarterly Form 941**: quarter range on pay_date; sum employee+employer
  FICA and federal withholding; wages = sum of `gross_pay`.
- **Annual Form 940 (FUTA)**: year range; FUTA wages and
  `employer_futa` totals (per-employee $7,000 cap is already applied per run).
- **W-2/W-3**: year range per employee; Box 1/3/5 wages = `gross_pay` (adjust
  per form rules), Box 2 = `federal_withholding`, Box 4 = `social_security`,
  Box 6 = `medicare`.

## Errors

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 400  | `unsupported_status` / `invalid_date` / `invalid_range` / `unsupported_format` |
| 401  | missing or wrong bearer token                       |
| 503  | export disabled (no `export-token` in SECRETS_DIR)  |
