# State withholding seed data (PAY-13 phase 1)

One JSON file per state-year: `<STATE>-<TAX_YEAR>.json` (e.g. `CA-2026.json`).
The seeder (`packages/db/src/state-seeds.ts`) imports every file in this
directory at build time (resolveJsonModule inlines them into dist) and upserts
`state_tax_configs` + `state_tax_brackets` idempotently.

## Format

```jsonc
{
  "state": "CA",                    // USPS 2-letter code
  "taxYear": 2026,
  "source": "EDD 2026 Withholding Schedules — Method B (26methb.pdf)",
  "jurisdictions": {
    // Key = the jurisdiction row written to state_tax_configs. Use the bare
    // state code for status-independent states; '<state>:<filing_status>'
    for status-specific parameter sets (resolution falls back
    '<state>:<status>' → '<state>').
    "CA:married_joint": {
      "kind": "progressive",        // 'none' | 'flat' | 'progressive'
      // --- scalar parameters (all optional unless kind requires them) ---
      "flatRate": 0.0495,           // required when kind='flat'
      "standardDeduction": 5706,    // annual, before brackets
      "standardDeductionAlt": 11412,      // applies when allowances >= altMinAllowances
      "altMinAllowances": 2,
      "lowIncomeExemption": 18896,        // annual wage floor → $0 withheld
      "lowIncomeExemptionAlt": 37791,
      "allowanceDeduction": 2925,         // annual wage-base deduction per REGULAR allowance
      "allowanceCredit": 168.30,          // annual after-bracket credit per REGULAR allowance
      "additionalAllowanceDeduction": 1000, // annual deduction per ADDITIONAL allowance
      // --- brackets: required when kind='progressive'; max null = top ---
      "brackets": [
        { "min": 0, "max": 22158, "rate": 0.011 },
        { "min": 22158, "max": null, "rate": 0.1463 }
      ]
    }
  }
}
```

## Semantics (what the engine does with these)

Annualized wage method, mirroring the federal path:

1. `annualGross = periodWage × periodsPerYear`
2. If `lowIncomeExemption` is set and `annualGross <= lowIncomeExemption`
   (alt-aware) → withhold $0.
3. `base = annualGross − additionalAllowances × additionalAllowanceDeduction
   − allowances × allowanceDeduction − standardDeduction` (floor $0; each
   term omitted when the config leaves it NULL).
4. `flat`: `tax = base × flatRate`. `progressive`: bracket walk over
   `brackets`. `none`: `tax = 0`.
5. `tax = max(0, tax − allowances × allowanceCredit)`.
6. Per period: `tax / periodsPerYear + extraWithholding` (from the
   employee's state election), rounded to cents.

## Encoded states (phase 1 — do NOT bulk-add the rest; that's phase 2)

| File          | State | Year(s) | Source |
| ------------- | ----- | ------- | ------ |
| `TX-2025.json`, `TX-2026.json` | Texas | 2025–26 | explicit `none` — no individual income tax |
| `IL-2025.json` | Illinois | 2025 | IDOR Booklet IL-700-T (2025): 4.95%, $2,850 / $1,000 allowances |
| `IL-2026.json` | Illinois | 2026 | IDOR Booklet IL-700-T (2026): 4.95%, $2,925 / $1,000 allowances |
| `CA-2026.json` | California | 2026 | EDD 2026 Withholding Schedules, Method B (exact calculation) |

Adding a state-year: drop a new JSON file here, add the import + entry to
`STATE_SEED_FILES` in `packages/db/src/state-seeds.ts`, and cover it with
withholding-scenario tests computed from the published state tables.
