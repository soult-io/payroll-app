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

Generate and deploy (on the home server) — ownership matters: compose bind-mounts
preserve host ownership and the app runs as uid/gid **10001**, so the file
must be `0600 10001:10001` like the other secrets:

```
sudo sh -c 'openssl rand -hex 32 > /srv/payroll/secrets/export-token'
sudo chown --reference=/srv/payroll/secrets/db-password /srv/payroll/secrets/export-token
sudo chmod --reference=/srv/payroll/secrets/db-password /srv/payroll/secrets/export-token
# stack redeploy picks it up (declared in the prod compose `secrets:` block —
# prod/docker-compose.yml in nsoult-agentic/stack-payroll)
```

Note: compose requires the file to exist at deploy time once the secret is
declared — to deploy WITHOUT the export API, comment out the `export-token`
entries in the deployment's compose file (top-level `secrets:` + the `app`
service list); the endpoint answers `503 export_disabled` when unconfigured.
(Same rule in `compose.example.yml` for self-hosters.)

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
  "company": { "legalName": "Example Corp", "ein": "12-3456789" },
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
        "gross_pay": "4200.00",
        "federal_withholding": "400.00",
        "social_security": "260.40",
        "medicare": "60.90",
        "state_withholding": "0.00",
        "net_pay": "3478.70",
        "employer_social_security": "260.40",
        "employer_medicare": "60.90",
        "employer_futa": "25.20"
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

## Contractor payments (Spec 10, D18)

```
GET /api/export/contractor-payments?year=YYYY
```

Per-contractor payments export for the January 1099/945 package. Same auth,
same read-only + audited doctrine (`action=export.contractor_payments`), same
no-surplus-PII rule: **no TIN, no bank details, no personal address** — the
only address-like data is the company header (`legalName`, decrypted `ein`).

| Param  | Default    | Notes                              |
| ------ | ---------- | ---------------------------------- |
| `year` | (required) | Tax year `YYYY`; keyed on pay_date |

### JSON response

```json
{
  "company": { "legalName": "Example Corp", "ein": "12-3456789" },
  "year": 2026,
  "threshold": "2000.00",
  "contractors": [
    {
      "employeeId": 7,
      "legalName": "Casey Contractor",
      "taxStatus": "us_person",
      "entityType": "individual",
      "form": { "taxForm": "w9", "collected": true, "formExpiresAt": null, "expired": false },
      "review1042": false,
      "payments": [
        { "payDate": "2026-03-15", "amount": "2500.00", "method": "ach", "backupWithheld": "600.00", "reference": "ach-123" }
      ],
      "reportableTotal": "2500.00",
      "grossTotal": "3400.00",
      "backupWithheldTotal": "816.00",
      "threshold": "2000.00",
      "formRequired": true
    }
  ]
}
```

- `threshold` is the dated federal 1099-NEC threshold for the year (from
  `contractor_reporting_config`: $600 through 2025, $2,000 for 2026,
  inflation-indexed from 2027; admin-editable per year). Missing config →
  `409 no_threshold_config`.
- `reportableTotal` EXCLUDES payments by `card` / `third_party_network` — the
  processor reports those on Form 1099-K (the carve-out prevents
  double-reporting). `grossTotal` is everything.
- `formRequired` = US person **and** `reportableTotal ≥ threshold` **and** no
  1042-S review flag. Below-threshold contractors are included with
  `formRequired: false` — the threshold decision is visible, never silent.
- `review1042` = `us_days_log` non-empty or `services_location` us/mixed → the
  contractor needs a **1042-S review** instead of a 1099-NEC (detection only;
  1042-S generation is out of scope, Spec 10 §7).
- `backupWithheldTotal` feeds the Form 945 reminder (24% backup withholding is
  reported on 1099-NEC box 4 and remitted via Form 945).
- Payments on void invoices are excluded from totals.
- All amounts are **strings to the cent** — parse as decimal, never float.

### Errors

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 400  | `invalid_year` (year required as `YYYY`)            |
| 401  | missing or wrong bearer token                       |
| 409  | `no_threshold_config` (run seeds / enter the year)  |
| 503  | export disabled (no `export-token` in SECRETS_DIR)  |

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
