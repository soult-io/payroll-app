# Research — 1099 contractors: domestic vs international

Compiled 2026-08-02 from current IRS guidance and 2025–2026 tax-law coverage. This memo is
the factual basis for Spec 10 (`plan/specs/contractors.md`).

## 1. Domestic contractor (US person)

A "US person" = US citizen, green-card holder, or resident alien (substantial-presence
test) — **regardless of where they physically live**. A US citizen living in Lisbon is
still domestic for 1099 purposes. Classification is by tax *status*, not location.

- **Form W-9** — collect before the first payment. Provides legal name, entity type, TIN
  (SSN/EIN). No expiry, but re-collect on any entity/name change.
- **Form 1099-NEC** — required for nonemployee compensation ≥ the reporting threshold:
  - **$600** for payments through 2025-12-31.
  - **$2,000** for payments on/after 2026-01-01 (OBBBA, July 2025), **inflation-indexed
    annually from 2027** (rounded to the nearest $100). The threshold must be dated,
    configurable config — never a hardcoded constant.
- **Backup withholding** — if the contractor fails to furnish a correct TIN (or IRS
  notifies of a mismatch), the payer must withhold **24%** of payments and remit via
  Form 945; still reported on 1099-NEC box 4. This is the one case where a contractor
  payment *does* have withholding — schema must allow it.
- **Deadline** — 1099-NEC to recipient and IRS by **January 31** (no 30-day extension
  like 1099-MISC).
- **E-file mandate** — 10+ total information returns (aggregated across types) → must
  e-file (IRIS or FIRE). Below 10, paper is permitted.
- **Payment-method carve-out** — payments made by credit card or through third-party
  payment networks (PayPal, Stripe, Wise platform payouts, etc.) are **excluded** from
  the payer's 1099-NEC; the processor reports on 1099-K. Tracking payment method per
  payment prevents double-reporting.
- **State divergence** — states need not conform to the $2,000 federal threshold; some
  still require reporting at $600 (e.g., MS, WI), and states with their own filing
  regimes differ. Treat state thresholds as future config, not V1 logic.

## 2. International contractor (non-US-resident alien)

- **Form W-8BEN** (individual) / **W-8BEN-E** (entity) — collect **before first payment**.
  Certificate of foreign status; establishes the payer has no 1099 obligation.
  **Valid for 3 calendar years** after signature → expiry/renewal tracking is required
  (same lifecycle shape as the existing W-4 `renewal_deadline`).
- **Sourcing rule (the decisive one)** — services income is sourced where the work is
  **physically performed**:
  - All work performed **outside the US** → foreign-source income → **no withholding,
    no Form 1042-S, no 1099-NEC**. The W-8BEN plus contract/invoice/payment records
    form the documentation packet the payer retains.
  - Any work performed **inside the US** (even a few days on-site) → that slice is
    US-source FDAP → **30% withholding** (or reduced treaty rate claimed on the
    W-8BEN / Form 8233) → reported on **Form 1042-S** (income code 17, independent
    personal services), due **March 15**, plus Form 1042 annual return.
- **Consequence for the app** — the system should capture a services-location assertion
  (and ideally a US-days log) so the "no 1042-S needed" position is documented, and so
  the rare US-source case is *detectable* even if 1042-S generation itself is out of
  scope.
- **Entity contractors** — W-8BEN-E (or W-8ECI if effectively-connected income); chapter 3
  withholding under §1442. Schema should distinguish individual vs entity.
- **Residency drift** — enough US days can flip a contractor through the
  substantial-presence test into US-person status mid-engagement → treatment changes to
  W-9/1099-NEC. A status field with effective dates handles this; no automatic detection
  is proposed.

## 3. Comparison table

| Aspect | Domestic (US person) | International (nonresident alien) |
|---|---|---|
| Onboarding form | W-9 (no expiry) | W-8BEN / W-8BEN-E (3-year validity) |
| Year-end form | 1099-NEC (Jan 31) | 1042-S (Mar 15) **only if US-source income** |
| Reporting threshold | $2,000 (2026, indexed) | none for foreign-source; any US-source $ reportable |
| Withholding | none, except 24% backup (missing TIN) | 0% foreign-source; 30%/treaty on US-source |
| Payment-method carve-out | card/TPN payments excluded (1099-K) | n/a for foreign-source |
| Schema impact | threshold config, TIN, backup-withholding flag | form type + expiry, country, services-location, US-days log |

## 4. What this means for payroll-app

1. Contractors are **not payroll runs**. No gross→net computation, no tax snapshot, no
   payslip. The money flow is invoice → approve → pay → record. Keeping contractor
   payments out of `payroll_runs` preserves the payroll engine's snapshot semantics.
2. The existing `employees.employment_type` CHECK already admits `'1099'` (schema.ts:87)
   and the admin create-employee endpoint already accepts it — the worker record is
   reusable; what's missing is the **classification + forms layer** and the
   **payments layer**.
3. Year-end is an **on-demand document** problem (1099-NEC PDF from stored payments —
   same deterministic, generated-not-stored doctrine as payslips, D5) plus a
   **threshold-config** problem (dated, indexed).
4. The export API (docs/export-api.md) should gain a contractor-payments read so the
   Accountant agent can assemble the 1099/1042 season package without new access paths.
