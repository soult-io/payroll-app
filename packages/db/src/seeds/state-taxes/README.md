# State withholding seed data (PAY-13)

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

## Encoded states

Phase 1 encoded TX/IL/CA; phase 2 completes the map. Every state + DC now
has a 2026 file (IL/TX also carry 2025):

- **All 41 income-tax jurisdictions** (39 states + DC), with each file's
  `source` field citing the official 2026 document — usually the state's own
  withholding guide as reproduced in the USDA National Finance Center's
  official per-state 2026 withholding formula bulletins
  (`help.nfc.usda.gov`, several states updated mid-2026: AR, GA, HI, IN, KY,
  LA, MD, NC, OR, VT, WV) — and documenting every closest-fit modeling
  exception inline (e.g. MD/IN county taxes, NY City/Yonkers, OH municipal
  and school-district taxes, OR federal-tax subtraction, MO KC/STL earnings
  tax, AL federal-tax deduction, WI sliding standard deduction, KS/SC/LA
  zero-exemption cases, CT exemption/recapture/personal-credit, AR
  high-income bracket adjustment).
- **Explicit `kind: "none"` rows** for the nine no-income-tax states
  (AK, FL, NV, NH, SD, TN, TX, WA, WY) so a work-state assignment resolves
  to $0 by configuration, never by absence.

Adding a state-year: drop a new JSON file here, add the import + entry to
`STATE_SEED_FILES` in `packages/db/src/state-seeds.ts`, and cover it with
withholding-scenario tests computed from the published state tables.
