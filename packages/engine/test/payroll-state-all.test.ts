/**
 * PAY-13 phase 2 — golden fixtures for EVERY 2026 income-tax state + DC and
 * the explicit no-tax states. Fixture constants mirror the DB seed JSON
 * (packages/db/src/seeds/state-taxes/<ST>-2026.json); each fixture comment
 * carries the seed file's official-source citation and closest-fit
 * exceptions. Expected values are computed from the published per-state
 * formula documented in that citation, not by re-running the engine.
 *
 * Coverage pattern per state: a mid-wage single scenario (1 allowance,
 * $6,000/mo) and — where the state publishes a married-joint parameter
 * set — a married scenario ($10,000/mo, 2 allowances).
 */

import { describe, expect, test } from "vitest";

import {
  calculatePayroll,
  TAX_CONFIG_2025,
  type PayrollInput,
  type StateTaxConfig,
} from "../src/payroll.js";

function stateInput(
  monthlySalary: number,
  config: StateTaxConfig,
  election: NonNullable<PayrollInput["state"]>["election"] = {},
  periodsPerYear?: 12 | 24 | 26 | 52,
): PayrollInput {
  return {
    monthlySalary,
    ...(periodsPerYear !== undefined ? { periodsPerYear } : {}),
    priorYtdGross: 0,
    taxConfig: TAX_CONFIG_2025,
    federalExempt: true, // isolate the state line — federal zeroed
    state: { config, election },
  };
}

// --------------------------------------------------------------------------
// Fixtures (mirrors of the seed JSON, with the official-source citations)
// --------------------------------------------------------------------------

/** Alaska has no individual income tax (AS 43.20 repealed 1980) — explicit zero-tax row so AK work-state assignment resolves to $0 by configuration, never by absence. */
const AK_2026: StateTaxConfig = {
  state: "AK",
  year: 2026,
  kind: "none",
};

/** Alabama Withholding Tax Tables and Instructions (2026) / USDA NFC 2026 AL formula */
const AL_2026: StateTaxConfig = {
  state: "AL",
  year: 2026,
  kind: "progressive",
  standardDeduction: 4000,
  allowanceDeduction: 1500,
  brackets: [
    { min: 0, max: 500, rate: 0.02 },
    { min: 500, max: 3000, rate: 0.04 },
    { min: 3000, max: Infinity, rate: 0.05 },
  ],
};

const AL_MARRIED_2026: StateTaxConfig = {
  state: "AL",
  year: 2026,
  kind: "progressive",
  standardDeduction: 7000,
  allowanceDeduction: 3000,
  brackets: [
    { min: 0, max: 1000, rate: 0.02 },
    { min: 1000, max: 6000, rate: 0.04 },
    { min: 6000, max: Infinity, rate: 0.05 },
  ],
};

/** Arkansas DFA Withholding Tax Formula (updated May 29, 2026 per H.B. 1001, top rate 3.9%→3.7% retroactive to Jan 1, 2026; reproduced in NFC bulletin NFC-26-1781190112, eff. pay period 15-2026): standard deduction $2,470; standard table 0%/2%/3%/3.4%/3.7% with minus-adjustments (encoded as marginal brackets — verified continuous through $94,701); $29 personal tax credit per exemption (encoded as allowanceCredit). CLOSEST-FIT EXCEPTIONS: (1) high-income bracket adjustment — above $94,701 Arkansas phases OUT the lower-bracket benefit via shrinking minus-adjustments, adding up to ~$287 of extra annual tax our marginal encoding under-withholds; (2) low-income tax tables / credit formulas (single <$17,500, married <$36,100, HoH <$29,000 wage phase-outs) NOT modeled — low-wage employees must elect the low-income table out-of-band; (3) truncate-to-$100/add-$50 rounding step not modeled (±$50 annual noise). */
const AR_2026: StateTaxConfig = {
  state: "AR",
  year: 2026,
  kind: "progressive",
  standardDeduction: 2470,
  allowanceCredit: 29,
  brackets: [
    { min: 0, max: 5600, rate: 0 },
    { min: 5600, max: 11200, rate: 0.02 },
    { min: 11200, max: 16000, rate: 0.03 },
    { min: 16000, max: 26400, rate: 0.034 },
    { min: 26400, max: Infinity, rate: 0.037 },
  ],
};

/** Arizona HB 2900 flat tax; ADOR A-4 instructions (2026) */
const AZ_2026: StateTaxConfig = {
  state: "AZ",
  year: 2026,
  kind: "flat",
  flatRate: 0.025,
};

/** California EDD 2026 Withholding Schedules — Method B exact calculation (26methb.pdf): low income exemption $18,896 (single / married 0-1) and $37,791 (married 2+ / HoH); standard deduction $5,706 / $11,412; personal exemption credit $168.30/yr per regular allowance; estimated-deduction allowance $1,000/yr each (DE 4 item 2). Brackets = annual Tables 5-7. */
const CA_2026: StateTaxConfig = {
  state: "CA",
  year: 2026,
  kind: "progressive",
  standardDeduction: 5706,
  lowIncomeExemption: 18896,
  allowanceCredit: 168.3,
  additionalAllowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 11079, rate: 0.011 },
    { min: 11079, max: 26264, rate: 0.022 },
    { min: 26264, max: 41452, rate: 0.044 },
    { min: 41452, max: 57542, rate: 0.066 },
    { min: 57542, max: 72724, rate: 0.088 },
    { min: 72724, max: 371479, rate: 0.1023 },
    { min: 371479, max: 445771, rate: 0.1133 },
    { min: 445771, max: 742953, rate: 0.1243 },
    { min: 742953, max: 1000000, rate: 0.1353 },
    { min: 1000000, max: Infinity, rate: 0.1463 },
  ],
};

const CA_MARRIED_2026: StateTaxConfig = {
  state: "CA",
  year: 2026,
  kind: "progressive",
  standardDeduction: 5706,
  standardDeductionAlt: 11412,
  altMinAllowances: 2,
  lowIncomeExemption: 18896,
  lowIncomeExemptionAlt: 37791,
  allowanceCredit: 168.3,
  additionalAllowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 22158, rate: 0.011 },
    { min: 22158, max: 52528, rate: 0.022 },
    { min: 52528, max: 82904, rate: 0.044 },
    { min: 82904, max: 115084, rate: 0.066 },
    { min: 115084, max: 145448, rate: 0.088 },
    { min: 145448, max: 742958, rate: 0.1023 },
    { min: 742958, max: 891542, rate: 0.1133 },
    { min: 891542, max: 1000000, rate: 0.1243 },
    { min: 1000000, max: 1485906, rate: 0.1353 },
    { min: 1485906, max: Infinity, rate: 0.1463 },
  ],
};

/** Colorado DOR DR 1098 Colorado Income Tax Withholding Worksheet for Employers (2026): flat 4.40% on annual wages minus the annual withholding allowance; DEFAULT allowance (no Form DR 0004 on file) $5,000 single/married-separate/head-of-household, $10,000 married filing joint — encoded as standardDeduction. CLOSEST-FIT EXCEPTION: DR 0004 Line 2 is a DOLLAR allowance (Table 1: $12,500 single one-job / $20,000 HoH / $27,500 MFJ; or Worksheet 1) with no count-based equivalent — employees should reconcile via extraWithholding or an admin-set election; FAMLI premium and city occupational privilege taxes not modeled. */
const CO_2026: StateTaxConfig = {
  state: "CO",
  year: 2026,
  kind: "flat",
  flatRate: 0.044,
  standardDeduction: 5000,
};

const CO_MARRIED_2026: StateTaxConfig = {
  state: "CO",
  year: 2026,
  kind: "flat",
  flatRate: 0.044,
  standardDeduction: 10000,
};

/** Connecticut 2026 Withholding Tables (DRS) / USDA NFC 2026 CT formula */
const CT_2026: StateTaxConfig = {
  state: "CT",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 10000, rate: 0.02 },
    { min: 10000, max: 50000, rate: 0.045 },
    { min: 50000, max: 100000, rate: 0.055 },
    { min: 100000, max: 200000, rate: 0.06 },
    { min: 200000, max: 250000, rate: 0.065 },
    { min: 250000, max: 500000, rate: 0.069 },
    { min: 500000, max: Infinity, rate: 0.0699 },
  ],
};

const CT_MARRIED_2026: StateTaxConfig = {
  state: "CT",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 20000, rate: 0.02 },
    { min: 20000, max: 100000, rate: 0.045 },
    { min: 100000, max: 200000, rate: 0.055 },
    { min: 200000, max: 400000, rate: 0.06 },
    { min: 400000, max: 500000, rate: 0.065 },
    { min: 500000, max: 1000000, rate: 0.069 },
    { min: 1000000, max: Infinity, rate: 0.0699 },
  ],
};

/** District of Columbia OTR 2026 withholding formula (Form D-4 basis; rate schedule unchanged since TY2022 per OTR and Tax Foundation 2026): $4,150 withholding allowance per D-4 allowance; single table for all filing statuses: 4% to $10,000, 6% to $40,000, 6.5% to $60,000, 8.5% to $250,000, 9.25% to $500,000, 9.75% to $1,000,000, 10.75% above. */
const DC_2026: StateTaxConfig = {
  state: "DC",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 4150,
  brackets: [
    { min: 0, max: 10000, rate: 0.04 },
    { min: 10000, max: 40000, rate: 0.06 },
    { min: 40000, max: 60000, rate: 0.065 },
    { min: 60000, max: 250000, rate: 0.085 },
    { min: 250000, max: 500000, rate: 0.0925 },
    { min: 500000, max: 1000000, rate: 0.0975 },
    { min: 1000000, max: Infinity, rate: 0.1075 },
  ],
};

/** Delaware Division of Revenue Employer's Guide (Withholding Regulations and Employer's Duties, 2026): annualized method — standard deduction $3,250 single/married-separate, $6,500 married joint; personal credit $110/yr per exemption (after-bracket credit); single graduated rate schedule for all statuses (cumulative $261 at $10,000 / $741 at $20,000 verified against the guide's worked examples). */
const DE_2026: StateTaxConfig = {
  state: "DE",
  year: 2026,
  kind: "progressive",
  standardDeduction: 3250,
  allowanceCredit: 110,
  brackets: [
    { min: 0, max: 2000, rate: 0 },
    { min: 2000, max: 5000, rate: 0.022 },
    { min: 5000, max: 10000, rate: 0.039 },
    { min: 10000, max: 20000, rate: 0.048 },
    { min: 20000, max: 25000, rate: 0.052 },
    { min: 25000, max: 60000, rate: 0.0555 },
    { min: 60000, max: Infinity, rate: 0.066 },
  ],
};

const DE_MARRIED_2026: StateTaxConfig = {
  state: "DE",
  year: 2026,
  kind: "progressive",
  standardDeduction: 6500,
  allowanceCredit: 110,
  brackets: [
    { min: 0, max: 2000, rate: 0 },
    { min: 2000, max: 5000, rate: 0.022 },
    { min: 5000, max: 10000, rate: 0.039 },
    { min: 10000, max: 20000, rate: 0.048 },
    { min: 20000, max: 25000, rate: 0.052 },
    { min: 25000, max: 60000, rate: 0.0555 },
    { min: 60000, max: Infinity, rate: 0.066 },
  ],
};

/** Florida has no individual income tax (Fla. Const. art. VII § 5(a)) — explicit zero-tax row so FL work-state assignment resolves to $0 by configuration, never by absence. */
const FL_2026: StateTaxConfig = {
  state: "FL",
  year: 2026,
  kind: "none",
};

/** Georgia 2026 Employer's Tax Guide (HB 463 rate 4.99%) */
const GA_2026: StateTaxConfig = {
  state: "GA",
  year: 2026,
  kind: "flat",
  flatRate: 0.0499,
  standardDeduction: 15000,
  allowanceDeduction: 5000,
};

const GA_MARRIED_2026: StateTaxConfig = {
  state: "GA",
  year: 2026,
  kind: "flat",
  flatRate: 0.0499,
  standardDeduction: 30000,
  allowanceDeduction: 5000,
};

/** Hawaii DOTAX 2026 withholding formula (HW-4 basis, reproduced in NFC bulletin NFC-26-1768321238, eff. pay period 15-2026): extra lump-sum withholding allowance $4,350 (encoded as standardDeduction) + $1,144 per exemption; graduated tables 1.40%–7.90% (H.B. 1042 lower-bracket relief already reflected in these thresholds). */
const HI_2026: StateTaxConfig = {
  state: "HI",
  year: 2026,
  kind: "progressive",
  standardDeduction: 4350,
  allowanceDeduction: 1144,
  brackets: [
    { min: 0, max: 9600, rate: 0.014 },
    { min: 9600, max: 14400, rate: 0.032 },
    { min: 14400, max: 19200, rate: 0.055 },
    { min: 19200, max: 24000, rate: 0.064 },
    { min: 24000, max: 36000, rate: 0.068 },
    { min: 36000, max: 48000, rate: 0.072 },
    { min: 48000, max: 125000, rate: 0.076 },
    { min: 125000, max: Infinity, rate: 0.079 },
  ],
};

const HI_MARRIED_2026: StateTaxConfig = {
  state: "HI",
  year: 2026,
  kind: "progressive",
  standardDeduction: 4350,
  allowanceDeduction: 1144,
  brackets: [
    { min: 0, max: 19200, rate: 0.014 },
    { min: 19200, max: 28800, rate: 0.032 },
    { min: 28800, max: 38400, rate: 0.055 },
    { min: 38400, max: 48000, rate: 0.064 },
    { min: 48000, max: 72000, rate: 0.068 },
    { min: 72000, max: 96000, rate: 0.072 },
    { min: 96000, max: 250000, rate: 0.076 },
    { min: 250000, max: Infinity, rate: 0.079 },
  ],
};

/** Iowa DOR 2026 withholding formulas and tables (issued 2025-11-03, accommodating OBBBA; IA W-4 form 44-019c 11/13/2025): flat 3.8%; standard deduction $13,000 single/married-dual-income/other, $19,500 head of household, $26,000 married single-income (encoded as the married_joint jurisdiction); $40/yr tax credit per allowance (after-bracket credit). School-district surtax / EMS surtax not modeled (local, out of scope). */
const IA_2026: StateTaxConfig = {
  state: "IA",
  year: 2026,
  kind: "flat",
  flatRate: 0.038,
  standardDeduction: 13000,
  allowanceCredit: 40,
};

const IA_MARRIED_2026: StateTaxConfig = {
  state: "IA",
  year: 2026,
  kind: "flat",
  flatRate: 0.038,
  standardDeduction: 26000,
  allowanceCredit: 40,
};

/** Idaho State Tax Commission 2026 withholding tables (tax.idaho.gov): flat 5.3% (H.B. 40, eff. 2025); Idaho conforms to the FEDERAL standard deduction (H.B. 559, Feb 2026 — OBBBA amounts $16,100 single / $32,200 MFJ); ID W-4 allowances are worth $0 (the allowance credit sunsetted) so no allowance fields are encoded. */
const ID_2026: StateTaxConfig = {
  state: "ID",
  year: 2026,
  kind: "flat",
  flatRate: 0.053,
  standardDeduction: 16100,
};

const ID_MARRIED_2026: StateTaxConfig = {
  state: "ID",
  year: 2026,
  kind: "flat",
  flatRate: 0.053,
  standardDeduction: 32200,
};

/** Illinois DOR Booklet IL-700-T (2026), effective 2026-01-01: flat 4.95%; IL-W-4 line 1 allowance $2,925/yr each, line 2 allowance $1,000/yr each; formula method: tax = 0.0495 × (wages − allowances ÷ periods). */
const IL_2026: StateTaxConfig = {
  state: "IL",
  year: 2026,
  kind: "flat",
  flatRate: 0.0495,
  allowanceDeduction: 2925,
  additionalAllowanceDeduction: 1000,
};

/** Indiana DOR Departmental Notice #1 (effective 2026-01-01): flat state rate 2.95% (IC 6-3-2-1 stepdown). WH-4 exemptions: $1,000 personal / $1,500 dependent / $3,000 adopted-child — modeled as a flat $1,000 deduction per allowance. CLOSEST-FIT EXCEPTIONS: tiered exemption values collapsed to $1,000/allowance; county local income tax (LIT, 0.5%–3%+ by county) not modeled (local tax out of scope). */
const IN_2026: StateTaxConfig = {
  state: "IN",
  year: 2026,
  kind: "flat",
  flatRate: 0.0295,
  allowanceDeduction: 1000,
};

/** Kansas DOR KW-100 Withholding Tax Guide & 2024 SB 1 rate structure (unchanged for 2026): two brackets 5.2% / 5.58% at $23,000 (single/HoH/MS) and $46,000 (MFJ). Standard deduction $3,605 S / $8,240 MFJ plus personal exemption $9,160 S / $18,320 MFJ encoded as a combined deduction ($12,765 / $26,560); dependent exemption $2,320 each as allowanceDeduction. */
const KS_2026: StateTaxConfig = {
  state: "KS",
  year: 2026,
  kind: "progressive",
  standardDeduction: 12765,
  allowanceDeduction: 2320,
  brackets: [
    { min: 0, max: 23000, rate: 0.052 },
    { min: 23000, max: Infinity, rate: 0.0558 },
  ],
};

const KS_MARRIED_2026: StateTaxConfig = {
  state: "KS",
  year: 2026,
  kind: "progressive",
  standardDeduction: 26560,
  allowanceDeduction: 2320,
  brackets: [
    { min: 0, max: 46000, rate: 0.052 },
    { min: 46000, max: Infinity, rate: 0.0558 },
  ],
};

/** Kentucky DOR Employer Payroll Withholding (revenue.ky.gov) & NFC bulletin NFC-26-1770145550 (eff. pay period 02-2026): flat 3.5% for 2026 (H.B. 8 trigger reduction from 4.0%); standard deduction $3,360; no allowance component. Local occupational taxes not modeled (out of scope). */
const KY_2026: StateTaxConfig = {
  state: "KY",
  year: 2026,
  kind: "flat",
  flatRate: 0.035,
  standardDeduction: 3360,
};

/** Louisiana DOR 2026 withholding formula (L-4 basis, NFC bulletin NFC-26-1767639939, eff. pay period 15-2026, LDR emergency rule Dec 2025 CPI adjustment): flat 3.09% withholding rate on wages minus standard deduction $12,875 single / $25,750 married (2+ deductions); per LDR guidance Head of Household and Qualifying Surviving Spouse use the MARRIED formula (encoded as an explicit HoH jurisdiction); dependent exemptions removed from the L-4. 'No standard deduction claimed' (0 personal exemptions) maps to allowances=0 — our engine still subtracts standardDeduction, a CLOSEST-FIT EXCEPTION (over-deducts $12,875 for 0-exemption elections). */
const LA_2026: StateTaxConfig = {
  state: "LA",
  year: 2026,
  kind: "flat",
  flatRate: 0.0309,
  standardDeduction: 12875,
};

const LA_MARRIED_2026: StateTaxConfig = {
  state: "LA",
  year: 2026,
  kind: "flat",
  flatRate: 0.0309,
  standardDeduction: 25750,
};

/** Massachusetts DOR 2026 withholding guide (Form M-4, reproduced in NFC bulletin NFC-26-1769797447, eff. pay period 10-2026): 5% flat plus 4% surtax over $1,107,750 (modeled as a 9% top bracket); exemptions modeled as $3,400 + $1,000/allowance (exact for >=1 exemption; a 0-allowance election over-deducts $3,400 — CLOSEST-FIT EXCEPTION); no withholding under $8,000/yr when >=1 exemption (encoded as lowIncomeExemption). The <=$2,000 FICA/retirement deduction and $120 HoH / $110 blind credits are not modeled. */
const MA_2026: StateTaxConfig = {
  state: "MA",
  year: 2026,
  kind: "progressive",
  standardDeduction: 3400,
  lowIncomeExemption: 8000,
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 1107750, rate: 0.05 },
    { min: 1107750, max: Infinity, rate: 0.09 },
  ],
};

/** Maryland Comptroller 2026 withholding formula (MW 507 basis, reproduced in NFC bulletin NFC-26-1783003892, eff. pay period 12-2026): standard deduction $3,400; exemption allowance $3,200 each; no withholding under $5,000/yr; graduated 4.75%–6.50% tables (6.25%/6.50% high-income brackets added for 2026). CLOSEST-FIT EXCEPTION: Maryland COUNTY income tax (2.25%–3.30% + Anne Arundel/Frederick graduated tables) is NOT modeled — local tax is out of ticket scope, so real Maryland net withholding will be materially higher; employers must add county tax outside this engine. */
const MD_2026: StateTaxConfig = {
  state: "MD",
  year: 2026,
  kind: "progressive",
  standardDeduction: 3400,
  lowIncomeExemption: 5000,
  allowanceDeduction: 3200,
  brackets: [
    { min: 0, max: 100000, rate: 0.0475 },
    { min: 100000, max: 125000, rate: 0.05 },
    { min: 125000, max: 150000, rate: 0.0525 },
    { min: 150000, max: 250000, rate: 0.055 },
    { min: 250000, max: 500000, rate: 0.0575 },
    { min: 500000, max: 1000000, rate: 0.0625 },
    { min: 1000000, max: Infinity, rate: 0.065 },
  ],
};

const MD_MARRIED_2026: StateTaxConfig = {
  state: "MD",
  year: 2026,
  kind: "progressive",
  standardDeduction: 3400,
  lowIncomeExemption: 5000,
  allowanceDeduction: 3200,
  brackets: [
    { min: 0, max: 150000, rate: 0.0475 },
    { min: 150000, max: 175000, rate: 0.05 },
    { min: 175000, max: 225000, rate: 0.0525 },
    { min: 225000, max: 300000, rate: 0.055 },
    { min: 300000, max: 600000, rate: 0.0575 },
    { min: 600000, max: 1200000, rate: 0.0625 },
    { min: 1200000, max: Infinity, rate: 0.065 },
  ],
};

/** Maine Revenue Services 2026 withholding formula (W-4ME basis, reproduced in NFC bulletin NFC-26-1771620053, eff. pay period 04-2026): standard deduction $12,450 single / $27,750 married; exemption $5,300/yr per allowance; tables 5.8% / 6.75% / 7.15%. CLOSEST-FIT EXCEPTION: the standard deduction PHASES OUT ($102,250–$177,250 single / $204,550–$354,550 married) — the phase-out is not modeled, so wages inside/above those ranges under-withhold; reconcile via extraWithholding. */
const ME_2026: StateTaxConfig = {
  state: "ME",
  year: 2026,
  kind: "progressive",
  standardDeduction: 12450,
  allowanceDeduction: 5300,
  brackets: [
    { min: 0, max: 27400, rate: 0.058 },
    { min: 27400, max: 64850, rate: 0.0675 },
    { min: 64850, max: Infinity, rate: 0.0715 },
  ],
};

const ME_MARRIED_2026: StateTaxConfig = {
  state: "ME",
  year: 2026,
  kind: "progressive",
  standardDeduction: 27750,
  allowanceDeduction: 5300,
  brackets: [
    { min: 0, max: 54850, rate: 0.058 },
    { min: 54850, max: 129750, rate: 0.0675 },
    { min: 129750, max: Infinity, rate: 0.0715 },
  ],
};

/** Michigan Treasury 2026 Income Tax Withholding Guide (Form 446, michigan.gov/withholding): flat 4.25% on compensation after the personal/dependency exemption allowance of $5,900/yr per MI-W4 exemption. City income taxes (Detroit and 23 others) not modeled (local, out of scope). */
const MI_2026: StateTaxConfig = {
  state: "MI",
  year: 2026,
  kind: "flat",
  flatRate: 0.0425,
  allowanceDeduction: 5900,
};

/** Minnesota DOR 2026 withholding formula (W-4MN basis, reproduced in NFC bulletin NFC-26-1782924992, eff. pay period 13-2026): exemption allowance $5,300/yr each; 0% / 5.35% / 6.80% / 7.85% / 9.85% tables. Minnesota's 1% net-investment-income surtax over $1M does not apply to wages. */
const MN_2026: StateTaxConfig = {
  state: "MN",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 5300,
  brackets: [
    { min: 0, max: 4700, rate: 0 },
    { min: 4700, max: 38010, rate: 0.0535 },
    { min: 38010, max: 114130, rate: 0.068 },
    { min: 114130, max: 207850, rate: 0.0785 },
    { min: 207850, max: Infinity, rate: 0.0985 },
  ],
};

const MN_MARRIED_2026: StateTaxConfig = {
  state: "MN",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 5300,
  brackets: [
    { min: 0, max: 14700, rate: 0 },
    { min: 14700, max: 63400, rate: 0.0535 },
    { min: 63400, max: 208180, rate: 0.068 },
    { min: 208180, max: 352630, rate: 0.0785 },
    { min: 352630, max: Infinity, rate: 0.0985 },
  ],
};

/** Missouri DOR 2026 Withholding Tax Formula (dor.mo.gov, Withholding_Formula_2026.pdf): federal-conformed standard deduction $16,100 single/married-spouse-works/married-separate, $32,200 married spouse-not-working (encoded as married_joint), $24,150 HoH; graduated 0%–4.7% brackets; the FEDERAL income tax deduction is ELIMINATED effective 2026. Kansas City / St. Louis 1% earnings taxes not modeled (local, out of scope). */
const MO_2026: StateTaxConfig = {
  state: "MO",
  year: 2026,
  kind: "progressive",
  standardDeduction: 16100,
  brackets: [
    { min: 0, max: 1313, rate: 0 },
    { min: 1313, max: 2626, rate: 0.02 },
    { min: 2626, max: 3939, rate: 0.025 },
    { min: 3939, max: 5252, rate: 0.03 },
    { min: 5252, max: 6565, rate: 0.035 },
    { min: 6565, max: 7878, rate: 0.04 },
    { min: 7878, max: 9191, rate: 0.045 },
    { min: 9191, max: Infinity, rate: 0.047 },
  ],
};

const MO_MARRIED_2026: StateTaxConfig = {
  state: "MO",
  year: 2026,
  kind: "progressive",
  standardDeduction: 32200,
  brackets: [
    { min: 0, max: 1313, rate: 0 },
    { min: 1313, max: 2626, rate: 0.02 },
    { min: 2626, max: 3939, rate: 0.025 },
    { min: 3939, max: 5252, rate: 0.03 },
    { min: 5252, max: 6565, rate: 0.035 },
    { min: 6565, max: 7878, rate: 0.04 },
    { min: 7878, max: 9191, rate: 0.045 },
    { min: 9191, max: Infinity, rate: 0.047 },
  ],
};

/** Mississippi DOR 2026 withholding formula (Form 89-350-25-8-1-000 Rev. 10/25, reproduced in NFC bulletin NFC-26-1768327516, eff. pay period 09-2026): 0% on first $10,000 of taxable income, flat 4.0% above (H.B. 1 2024 glide path: 4.7%→4.4%→4.0% for 2026); standard deduction $2,300 S / $3,400 HoF / $4,600 M combined with personal exemption $6,000 S / $9,500 HoF / $12,000 M as a single deduction; dependents/65+/blind $1,500 each as allowanceDeduction. */
const MS_2026: StateTaxConfig = {
  state: "MS",
  year: 2026,
  kind: "progressive",
  standardDeduction: 8300,
  allowanceDeduction: 1500,
  brackets: [
    { min: 0, max: 10000, rate: 0 },
    { min: 10000, max: Infinity, rate: 0.04 },
  ],
};

const MS_MARRIED_2026: StateTaxConfig = {
  state: "MS",
  year: 2026,
  kind: "progressive",
  standardDeduction: 16600,
  allowanceDeduction: 1500,
  brackets: [
    { min: 0, max: 10000, rate: 0 },
    { min: 10000, max: Infinity, rate: 0.04 },
  ],
};

/** Montana DOR 2026 wage withholding tables (revenue.mt.gov 2026 withholding updates, H.B. 337; reproduced in NFC bulletin NFC-26-1767632355, eff. pay period 05-2026): top rate cut to 5.65%; two-rate structure 4.7%/5.65% with a 0% band equal to the federal standard deduction baked into the table (thresholds are on gross wages). */
const MT_2026: StateTaxConfig = {
  state: "MT",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 16100, rate: 0 },
    { min: 16100, max: 63600, rate: 0.047 },
    { min: 63600, max: Infinity, rate: 0.0565 },
  ],
};

const MT_MARRIED_2026: StateTaxConfig = {
  state: "MT",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 32200, rate: 0 },
    { min: 32200, max: 127200, rate: 0.047 },
    { min: 127200, max: Infinity, rate: 0.0565 },
  ],
};

/** North Carolina DOR NC-30 2026 withholding formula / USDA NFC PP09-2026: flat rate 4.09% (reduced from 4.25% by S.L. 2023-134 trigger), standard deduction $12,750 single / $12,750 married (per spouse basis) / $19,125 head of household, $2,500 deduction per qualifying-child allowance. */
const NC_2026: StateTaxConfig = {
  state: "NC",
  year: 2026,
  kind: "flat",
  flatRate: 0.0409,
  standardDeduction: 12750,
  allowanceDeduction: 2500,
};

const NC_MARRIED_2026: StateTaxConfig = {
  state: "NC",
  year: 2026,
  kind: "flat",
  flatRate: 0.0409,
  standardDeduction: 12750,
  allowanceDeduction: 2500,
};

/** ND Office of State Tax Commissioner 2026 income tax withholding tables (reproduced in NFC bulletin NFC-26-1767646699, eff. pay period 13-2026): 0% / 1.95% / 2.5% brackets applied to annualized wages (post-2020 W-4 basis — no exemption deduction; pre-2020 W-4 $5,050/exemption variant not modeled). Head-of-household table not modeled (falls back to single). */
const ND_2026: StateTaxConfig = {
  state: "ND",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 57625, rate: 0 },
    { min: 57625, max: 258450, rate: 0.0195 },
    { min: 258450, max: Infinity, rate: 0.025 },
  ],
};

const ND_MARRIED_2026: StateTaxConfig = {
  state: "ND",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 57500, rate: 0 },
    { min: 57500, max: 168525, rate: 0.0195 },
    { min: 168525, max: Infinity, rate: 0.025 },
  ],
};

/** Nebraska DOR 2026 withholding formula (W-4N basis, reproduced in NFC bulletin NFC-26-1774374744, eff. pay period 04-2026): withholding allowance $2,440/yr each; tables 2.26%–4.60% (LB 754 rate step-down). CLOSEST-FIT EXCEPTION: the LB223 minimum tax (annual tax must be at least 50% of the tax computed with 1 exemption single / 2 married) is not modeled — employees claiming many allowances may be under-withheld relative to the official formula. */
const NE_2026: StateTaxConfig = {
  state: "NE",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 2440,
  brackets: [
    { min: 0, max: 3430, rate: 0 },
    { min: 3430, max: 6710, rate: 0.0226 },
    { min: 6710, max: 21810, rate: 0.0322 },
    { min: 21810, max: 31610, rate: 0.0421 },
    { min: 31610, max: 40130, rate: 0.0435 },
    { min: 40130, max: 75370, rate: 0.0448 },
    { min: 75370, max: Infinity, rate: 0.046 },
  ],
};

const NE_MARRIED_2026: StateTaxConfig = {
  state: "NE",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 2440,
  brackets: [
    { min: 0, max: 8190, rate: 0 },
    { min: 8190, max: 13010, rate: 0.0226 },
    { min: 13010, max: 32400, rate: 0.0322 },
    { min: 32400, max: 50400, rate: 0.0421 },
    { min: 50400, max: 62530, rate: 0.0435 },
    { min: 62530, max: 82920, rate: 0.0448 },
    { min: 82920, max: Infinity, rate: 0.046 },
  ],
};

/** New Hampshire has no tax on wage income; the former 3% interest & dividends tax was fully repealed effective January 1, 2025 (RSA 77, as amended by 2023 N.H. Laws ch. 179) — explicit zero-tax row so NH work-state assignment resolves to $0 by configuration, never by absence. */
const NH_2026: StateTaxConfig = {
  state: "NH",
  year: 2026,
  kind: "none",
};

/** New Jersey Treasury NJ-WT Withholding Instructions & 2026 Withholding Rate Tables (nj.gov/treasury/taxation/pdf/withholdingtables.pdf): Rate A (single/married-separate) and Rate B (married joint/civil union, HoH fallback) annual schedules 1.5%–11.8% (11.8% over $1M new for 2026); $1,000/yr per NJ-W4 allowance. EXCEPTION: employee-elected higher rate tables C/D/E (NJ-W4 line 3) not modeled — use extraWithholding. */
const NJ_2026: StateTaxConfig = {
  state: "NJ",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 20000, rate: 0.015 },
    { min: 20000, max: 35000, rate: 0.02 },
    { min: 35000, max: 40000, rate: 0.039 },
    { min: 40000, max: 75000, rate: 0.061 },
    { min: 75000, max: 500000, rate: 0.07 },
    { min: 500000, max: 1000000, rate: 0.099 },
    { min: 1000000, max: Infinity, rate: 0.118 },
  ],
};

const NJ_MARRIED_2026: StateTaxConfig = {
  state: "NJ",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 20000, rate: 0.015 },
    { min: 20000, max: 50000, rate: 0.02 },
    { min: 50000, max: 70000, rate: 0.027 },
    { min: 70000, max: 80000, rate: 0.039 },
    { min: 80000, max: 150000, rate: 0.061 },
    { min: 150000, max: 500000, rate: 0.07 },
    { min: 500000, max: 1000000, rate: 0.099 },
    { min: 1000000, max: Infinity, rate: 0.118 },
  ],
};

/** New Mexico TRD 2026 withholding tables (reproduced in NFC bulletin NFC-26-1776874663, eff. pay period 11-2026): 0% band equal to the federal standard deduction then 1.5%/3.2%/4.3%/4.7%/4.9%/5.9% on gross wages (same-rate adjacent rows merged); no allowance component — basis is federal filing status only. */
const NM_2026: StateTaxConfig = {
  state: "NM",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 8050, rate: 0 },
    { min: 8050, max: 13550, rate: 0.015 },
    { min: 13550, max: 24550, rate: 0.032 },
    { min: 24550, max: 41550, rate: 0.043 },
    { min: 41550, max: 74550, rate: 0.047 },
    { min: 74550, max: 218050, rate: 0.049 },
    { min: 218050, max: Infinity, rate: 0.059 },
  ],
};

const NM_MARRIED_2026: StateTaxConfig = {
  state: "NM",
  year: 2026,
  kind: "progressive",
  brackets: [
    { min: 0, max: 16100, rate: 0 },
    { min: 16100, max: 24100, rate: 0.015 },
    { min: 24100, max: 41100, rate: 0.032 },
    { min: 41100, max: 66100, rate: 0.043 },
    { min: 66100, max: 116100, rate: 0.047 },
    { min: 116100, max: 331100, rate: 0.049 },
    { min: 331100, max: Infinity, rate: 0.059 },
  ],
};

/** Nevada has no individual income tax — explicit zero-tax row so NV work-state assignment resolves to $0 by configuration, never by absence. */
const NV_2026: StateTaxConfig = {
  state: "NV",
  year: 2026,
  kind: "none",
};

/** NYS-50-T-NYS (1/26) Method II Exact Calculation (annual schedule, reproduced in NFC bulletin NFC-26-1772477134, eff. pay period 02-2026): standard deduction $7,400 single/HoH, $7,950 married; exemption allowance $1,000/yr each (IT-2104). CLOSEST-FIT EXCEPTIONS: (1) Method III — above $1,077,550 single / $2,155,350 married NY taxes ALL wages at flat 10.45%/11.10%/11.70% — encoded as a 10.45% marginal top bracket instead (diverges only for ultra-high wages); (2) the 6.40%/11.44% (single) and 6.40%/13.49% (married) bubble ranges are the benefit-recapture rows, encoded as written; (3) New York City and Yonkers income taxes NOT modeled (local, out of scope). */
const NY_2026: StateTaxConfig = {
  state: "NY",
  year: 2026,
  kind: "progressive",
  standardDeduction: 7400,
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 8500, rate: 0.039 },
    { min: 8500, max: 11700, rate: 0.044 },
    { min: 11700, max: 13900, rate: 0.0515 },
    { min: 13900, max: 80650, rate: 0.054 },
    { min: 80650, max: 96800, rate: 0.059 },
    { min: 96800, max: 107650, rate: 0.0703 },
    { min: 107650, max: 157650, rate: 0.0753 },
    { min: 157650, max: 215400, rate: 0.064 },
    { min: 215400, max: 265400, rate: 0.1144 },
    { min: 265400, max: 1077550, rate: 0.0685 },
    { min: 1077550, max: Infinity, rate: 0.1045 },
  ],
};

const NY_MARRIED_2026: StateTaxConfig = {
  state: "NY",
  year: 2026,
  kind: "progressive",
  standardDeduction: 7950,
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 8500, rate: 0.039 },
    { min: 8500, max: 11700, rate: 0.044 },
    { min: 11700, max: 13900, rate: 0.0515 },
    { min: 13900, max: 80650, rate: 0.054 },
    { min: 80650, max: 96800, rate: 0.059 },
    { min: 96800, max: 107650, rate: 0.0657 },
    { min: 107650, max: 157650, rate: 0.0707 },
    { min: 157650, max: 211550, rate: 0.0801 },
    { min: 211550, max: 323200, rate: 0.064 },
    { min: 323200, max: 373200, rate: 0.1349 },
    { min: 373200, max: 1077550, rate: 0.0735 },
    { min: 1077550, max: 2155350, rate: 0.0765 },
    { min: 2155350, max: Infinity, rate: 0.1045 },
  ],
};

/** Ohio DOR 2026 withholding tables (H.B. 96 flat-tax transition, new tables effective Aug 1, 2026): 0% up to $26,050 of annual taxable income, flat 2.75% above; $650 personal-exemption deduction per exemption. CLOSEST-FIT EXCEPTIONS: mid-year table change encoded as full-year effective; employer school-district income tax and municipal (RITA/CCA) local taxes NOT modeled. */
const OH_2026: StateTaxConfig = {
  state: "OH",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 650,
  brackets: [
    { min: 0, max: 26050, rate: 0 },
    { min: 26050, max: Infinity, rate: 0.0275 },
  ],
};

/** Oklahoma Tax Commission Packet OW-2 2026 withholding tables (H.B. 2764, eff. Jan 1, 2026: six brackets consolidated to three positive rates, top rate 4.75%→4.50%): standard deduction $6,350 single / $12,700 married; $1,000 personal-exemption withholding allowance each; single taxable-income brackets 0% to $3,750, 2.5% to $4,900, 3.5% to $7,200, 4.5% above (married doubled). NOTE: HB 2764 contains a revenue-trigger for a further 0.25pp cut — not reflected. */
const OK_2026: StateTaxConfig = {
  state: "OK",
  year: 2026,
  kind: "progressive",
  standardDeduction: 6350,
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 3750, rate: 0 },
    { min: 3750, max: 4900, rate: 0.025 },
    { min: 4900, max: 7200, rate: 0.035 },
    { min: 7200, max: Infinity, rate: 0.045 },
  ],
};

const OK_MARRIED_2026: StateTaxConfig = {
  state: "OK",
  year: 2026,
  kind: "progressive",
  standardDeduction: 12700,
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 7500, rate: 0 },
    { min: 7500, max: 9800, rate: 0.025 },
    { min: 9800, max: 14400, rate: 0.035 },
    { min: 14400, max: Infinity, rate: 0.045 },
  ],
};

/** Oregon DOR Publication 150-206-436 (2026, rev. 12-31-25): standard deduction $2,910 single with <3 allowances / $5,820 married or 3+ allowances; exemption credit $263/yr per allowance; brackets below. CLOSEST-FIT EXCEPTIONS: the official formula subtracts federal income tax withheld (capped at $8,750, phased out $125k–145k single / $250k–290k married) before brackets — our engine has no federal-tax input, so withholding runs slightly HIGH; the 0.2% statewide transit tax and Portland Metro/Multnomah local taxes are not modeled (local tax out of scope). */
const OR_2026: StateTaxConfig = {
  state: "OR",
  year: 2026,
  kind: "progressive",
  standardDeduction: 2910,
  standardDeductionAlt: 5820,
  altMinAllowances: 3,
  allowanceCredit: 263,
  brackets: [
    { min: 0, max: 4550, rate: 0.0475 },
    { min: 4550, max: 11400, rate: 0.0675 },
    { min: 11400, max: 125000, rate: 0.0875 },
    { min: 125000, max: Infinity, rate: 0.099 },
  ],
};

const OR_MARRIED_2026: StateTaxConfig = {
  state: "OR",
  year: 2026,
  kind: "progressive",
  standardDeduction: 5820,
  allowanceCredit: 263,
  brackets: [
    { min: 0, max: 9100, rate: 0.0475 },
    { min: 9100, max: 22800, rate: 0.0675 },
    { min: 22800, max: 250000, rate: 0.0875 },
    { min: 250000, max: Infinity, rate: 0.099 },
  ],
};

/** PA DOR Employer Withholding guide (pa.gov, rev-1667) & 72 P.S. § 7302, 2026: flat 3.07% on gross compensation; Pennsylvania has no standard deduction, personal exemption, or allowance — every dollar is taxed. */
const PA_2026: StateTaxConfig = {
  state: "PA",
  year: 2026,
  kind: "flat",
  flatRate: 0.0307,
};

/** Rhode Island Division of Taxation 2026 withholding formula (RI W-4 basis, NFC bulletin NFC-26-1772030778, eff. pay period 03-2026): $1,000 exemption amount per allowance; table 3.75% to $82,050, 4.75% to $186,450, 5.99% above. CLOSEST-FIT EXCEPTION: the $1,000 exemption is ELIMINATED when annualized wages exceed $290,800 — not modeled, engine always grants it (under-withholds ~$38/yr per allowance above the threshold). */
const RI_2026: StateTaxConfig = {
  state: "RI",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 1000,
  brackets: [
    { min: 0, max: 82050, rate: 0.0375 },
    { min: 82050, max: 186450, rate: 0.0475 },
    { min: 186450, max: Infinity, rate: 0.0599 },
  ],
};

/** South Carolina DOR 2026 withholding formula (SC-4 basis, NFC bulletin NFC-26-1773173131, eff. pay period 03-2026): standard deduction = lesser of 10% of annual wages or $7,500 when 1+ exemptions claimed; $5,000 deduction per personal exemption; table 0% to $3,640, 3.0% to $18,230, 6.0% above. CLOSEST-FIT EXCEPTIONS: (1) the 10%-of-wages standard deduction for annual wages under $75,000 is not modeled — engine always deducts the $7,500 maximum (under-withholds for wages <$75k); (2) zero-exemption elections receive NO standard deduction under the state formula but our engine still deducts $7,500. */
const SC_2026: StateTaxConfig = {
  state: "SC",
  year: 2026,
  kind: "progressive",
  standardDeduction: 7500,
  allowanceDeduction: 5000,
  brackets: [
    { min: 0, max: 3640, rate: 0 },
    { min: 3640, max: 18230, rate: 0.03 },
    { min: 18230, max: Infinity, rate: 0.06 },
  ],
};

/** South Dakota has no individual income tax (S.D. Const. art. XI § 2) — explicit zero-tax row so SD work-state assignment resolves to $0 by configuration, never by absence. */
const SD_2026: StateTaxConfig = {
  state: "SD",
  year: 2026,
  kind: "none",
};

/** Tennessee has no individual income tax on wages; the Hall income tax on interest and dividends was fully repealed effective January 1, 2021 (Tenn. Code Ann. § 67-2-110) — explicit zero-tax row so TN work-state assignment resolves to $0 by configuration, never by absence. */
const TN_2026: StateTaxConfig = {
  state: "TN",
  year: 2026,
  kind: "none",
};

/** Texas has no individual income tax (Tex. Const. art. VIII § 24) — explicit zero-tax row so TX work-state assignment resolves to $0 by configuration, never by absence. */
const TX_2026: StateTaxConfig = {
  state: "TX",
  year: 2026,
  kind: "none",
};

/** Utah State Tax Commission Publication 14 (2026, reproduced in NFC bulletin NFC-26-1782763921, eff. pay period 12-2026): flat 4.45% on annualized wages. CLOSEST-FIT EXCEPTION: Utah's taxpayer-credit withholding allowance (base credit phased out at 1.3% of wages above $9,348 single / $18,696 married) is a wage-based credit our per-allowance model cannot express — withholding runs slightly HIGH for low/mid wages; employees can compensate via the exempt flag or a negative-ish adjustment through extraWithholding-free election. */
const UT_2026: StateTaxConfig = {
  state: "UT",
  year: 2026,
  kind: "flat",
  flatRate: 0.0445,
};

const UT_MARRIED_2026: StateTaxConfig = {
  state: "UT",
  year: 2026,
  kind: "flat",
  flatRate: 0.0445,
};

/** Virginia Tax 2026 withholding formula (VA-4 basis; NFC bulletin NFC-25-1750694986, standard deduction $8,750 single / $17,500 married joint for TY2025-2026 per 2025 Appropriation Act ch. 725, sunset removal pending SB 676): personal/dependent exemption $930 each, age/blindness additional exemption $800 each (encoded as additionalAllowanceDeduction); single table for all statuses 2% to $3,000, 3% to $5,000, 5% to $17,000, 5.75% above. */
const VA_2026: StateTaxConfig = {
  state: "VA",
  year: 2026,
  kind: "progressive",
  standardDeduction: 8750,
  allowanceDeduction: 930,
  additionalAllowanceDeduction: 800,
  brackets: [
    { min: 0, max: 3000, rate: 0.02 },
    { min: 3000, max: 5000, rate: 0.03 },
    { min: 5000, max: 17000, rate: 0.05 },
    { min: 17000, max: Infinity, rate: 0.0575 },
  ],
};

const VA_MARRIED_2026: StateTaxConfig = {
  state: "VA",
  year: 2026,
  kind: "progressive",
  standardDeduction: 17500,
  allowanceDeduction: 930,
  additionalAllowanceDeduction: 800,
  brackets: [
    { min: 0, max: 3000, rate: 0.02 },
    { min: 3000, max: 5000, rate: 0.03 },
    { min: 5000, max: 17000, rate: 0.05 },
    { min: 17000, max: Infinity, rate: 0.0575 },
  ],
};

/** Vermont Department of Taxes 2026 withholding formula (W-4VT basis, NFC bulletin NFC-26-1780320782, eff. pay period 09-2026): $5,400 exemption allowance per allowance; Single/Head-of-Household table 0% to $3,925, 3.35% to $54,675, 6.60% to $126,775, 7.60% to $260,225, 8.75% above; Married table 0% to $11,775, 3.35% to $96,475, 6.60% to $216,525, 7.60% to $323,825, 8.75% above. CLOSEST-FIT EXCEPTION: Vermont adds 30% of any elected ADDITIONAL FEDERAL withholding to state withholding — not modeled; employees should fold this into extraWithholding. */
const VT_2026: StateTaxConfig = {
  state: "VT",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 5400,
  brackets: [
    { min: 0, max: 3925, rate: 0 },
    { min: 3925, max: 54675, rate: 0.0335 },
    { min: 54675, max: 126775, rate: 0.066 },
    { min: 126775, max: 260225, rate: 0.076 },
    { min: 260225, max: Infinity, rate: 0.0875 },
  ],
};

const VT_MARRIED_2026: StateTaxConfig = {
  state: "VT",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 5400,
  brackets: [
    { min: 0, max: 11775, rate: 0 },
    { min: 11775, max: 96475, rate: 0.0335 },
    { min: 96475, max: 216525, rate: 0.066 },
    { min: 216525, max: 323825, rate: 0.076 },
    { min: 323825, max: Infinity, rate: 0.0875 },
  ],
};

/** Washington has no individual income tax on wages (the 7% capital-gains excise tax under RCW 82.87 is not wage withholding) — explicit zero-tax row so WA work-state assignment resolves to $0 by configuration, never by absence. */
const WA_2026: StateTaxConfig = {
  state: "WA",
  year: 2026,
  kind: "none",
};

/** Wisconsin DOR Publication W-166 2026 Alternate Method withholding (WT-4 basis): $400 per exemption; single table for all statuses 3.54% to $12,760, 4.65% to $25,520, 5.30% to $280,950, 7.65% above. CLOSEST-FIT EXCEPTION: Wisconsin's sliding payroll standard deduction (max $6,702 single / $9,461 married, phasing out 12%/20% of wages above the threshold to $0 at ~$73k) cannot be expressed as a fixed deduction — engine encodes the MAXIMUM, under-withholding for employees in the phase-out range; affected employees should compensate via extraWithholding. */
const WI_2026: StateTaxConfig = {
  state: "WI",
  year: 2026,
  kind: "progressive",
  standardDeduction: 6702,
  allowanceDeduction: 400,
  brackets: [
    { min: 0, max: 12760, rate: 0.0354 },
    { min: 12760, max: 25520, rate: 0.0465 },
    { min: 25520, max: 280950, rate: 0.053 },
    { min: 280950, max: Infinity, rate: 0.0765 },
  ],
};

const WI_MARRIED_2026: StateTaxConfig = {
  state: "WI",
  year: 2026,
  kind: "progressive",
  standardDeduction: 9461,
  allowanceDeduction: 400,
  brackets: [
    { min: 0, max: 12760, rate: 0.0354 },
    { min: 12760, max: 25520, rate: 0.0465 },
    { min: 25520, max: 280950, rate: 0.053 },
    { min: 280950, max: Infinity, rate: 0.0765 },
  ],
};

/** West Virginia Tax Division 2026 withholding tables (S.B. 392, signed Mar 31, 2026, 5% rate cut retroactive to Jan 1, 2026; withholding effective Jun 12, 2026): rates 2.11%/2.81%/3.16%/4.22%/4.58% at $10,000/$25,000/$40,000/$60,000; $2,000 personal exemption per exemption. CLOSEST-FIT EXCEPTIONS: (1) two-earner/two-jobs withholding table (thresholds 75% of standard) not modeled — default one-earner/one-job table encoded for all statuses; (2) zero-exemption filers may claim only a reduced $500 exemption on the return — engine exempts $0 for allowances=0 (conservative). */
const WV_2026: StateTaxConfig = {
  state: "WV",
  year: 2026,
  kind: "progressive",
  allowanceDeduction: 2000,
  brackets: [
    { min: 0, max: 10000, rate: 0.0211 },
    { min: 10000, max: 25000, rate: 0.0281 },
    { min: 25000, max: 40000, rate: 0.0316 },
    { min: 40000, max: 60000, rate: 0.0422 },
    { min: 60000, max: Infinity, rate: 0.0458 },
  ],
};

/** Wyoming has no individual income tax — explicit zero-tax row so WY work-state assignment resolves to $0 by configuration, never by absence. */
const WY_2026: StateTaxConfig = {
  state: "WY",
  year: 2026,
  kind: "none",
};

// --------------------------------------------------------------------------
// Golden scenarios
// --------------------------------------------------------------------------

describe("2026 per-state golden fixtures", () => {
  test("AK: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, AK_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("AL: $6,000/mo single 1 allowance → $273.75/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, AL_2026, { allowances: 1 })).stateWithholding).toBe(
      273.75,
    );
  });

  test("AL married: $10,000/mo married-joint 2 allowances → $439.17/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, AL_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(439.17);
  });

  test("AR: $6,000/mo single 1 allowance → $181.37/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, AR_2026, { allowances: 1 })).stateWithholding).toBe(
      181.37,
    );
  });

  test("AZ: $6,000/mo single 1 allowance → $150.00/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, AZ_2026, { allowances: 1 })).stateWithholding).toBe(
      150.0,
    );
  });

  test("CA: $6,000/mo single 1 allowance → $232.34/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, CA_2026, { allowances: 1 })).stateWithholding).toBe(
      232.34,
    );
  });

  test("CA married: $10,000/mo married-joint 2 allowances → $300.58/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, CA_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(300.58);
  });

  test("CO: $6,000/mo single 1 allowance → $245.67/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, CO_2026, { allowances: 1 })).stateWithholding).toBe(
      245.67,
    );
  });

  test("CO married: $10,000/mo married-joint 2 allowances → $403.33/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, CO_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(403.33);
  });

  test("CT: $6,000/mo single 1 allowance → $267.50/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, CT_2026, { allowances: 1 })).stateWithholding).toBe(
      267.5,
    );
  });

  test("CT married: $10,000/mo married-joint 2 allowances → $425.00/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, CT_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(425.0);
  });

  test("DC: $6,000/mo single 1 allowance → $347.27/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, DC_2026, { allowances: 1 })).stateWithholding).toBe(
      347.27,
    );
  });

  test("DE: $6,000/mo single 1 allowance → $284.25/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, DE_2026, { allowances: 1 })).stateWithholding).toBe(
      284.25,
    );
  });

  test("DE married: $10,000/mo married-joint 2 allowances → $521.21/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, DE_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(521.21);
  });

  test("FL: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, FL_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("GA: $6,000/mo single 1 allowance → $216.23/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, GA_2026, { allowances: 1 })).stateWithholding).toBe(
      216.23,
    );
  });

  test("GA married: $10,000/mo married-joint 2 allowances → $332.67/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, GA_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(332.67);
  });

  test("HI: $6,000/mo single 1 allowance → $328.80/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, HI_2026, { allowances: 1 })).stateWithholding).toBe(
      328.8,
    );
  });

  test("HI married: $10,000/mo married-joint 2 allowances → $533.16/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, HI_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(533.16);
  });

  test("IA: $6,000/mo single 1 allowance → $183.50/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, IA_2026, { allowances: 1 })).stateWithholding).toBe(
      183.5,
    );
  });

  test("IA married: $10,000/mo married-joint 2 allowances → $291.00/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, IA_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(291.0);
  });

  test("ID: $6,000/mo single 1 allowance → $246.89/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, ID_2026, { allowances: 1 })).stateWithholding).toBe(
      246.89,
    );
  });

  test("ID married: $10,000/mo married-joint 2 allowances → $387.78/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, ID_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(387.78);
  });

  test("IL: $6,000/mo single 1 allowance → $284.93/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, IL_2026, { allowances: 1 })).stateWithholding).toBe(
      284.93,
    );
  });

  test("IN: $6,000/mo single 1 allowance → $174.54/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, IN_2026, { allowances: 1 })).stateWithholding).toBe(
      174.54,
    );
  });

  test("KS: $6,000/mo single 1 allowance → $257.37/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, KS_2026, { allowances: 1 })).stateWithholding).toBe(
      257.37,
    );
  });

  test("KS married: $10,000/mo married-joint 2 allowances → $398.35/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, KS_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(398.35);
  });

  test("KY: $6,000/mo single 1 allowance → $200.20/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, KY_2026, { allowances: 1 })).stateWithholding).toBe(
      200.2,
    );
  });

  test("LA: $6,000/mo single 1 allowance → $152.25/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, LA_2026, { allowances: 1 })).stateWithholding).toBe(
      152.25,
    );
  });

  test("LA married: $10,000/mo married-joint 2 allowances → $242.69/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, LA_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(242.69);
  });

  test("MA: $6,000/mo single 1 allowance → $281.67/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MA_2026, { allowances: 1 })).stateWithholding).toBe(
      281.67,
    );
  });

  test("MD: $6,000/mo single 1 allowance → $258.88/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MD_2026, { allowances: 1 })).stateWithholding).toBe(
      258.88,
    );
  });

  test("MD married: $10,000/mo married-joint 2 allowances → $436.21/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, MD_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(436.21);
  });

  test("ME: $6,000/mo single 1 allowance → $283.46/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, ME_2026, { allowances: 1 })).stateWithholding).toBe(
      283.46,
    );
  });

  test("ME married: $10,000/mo married-joint 2 allowances → $415.86/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, ME_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(415.86);
  });

  test("MI: $6,000/mo single 1 allowance → $234.10/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MI_2026, { allowances: 1 })).stateWithholding).toBe(
      234.1,
    );
  });

  test("MN: $6,000/mo single 1 allowance → $311.08/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MN_2026, { allowances: 1 })).stateWithholding).toBe(
      311.08,
    );
  });

  test("MN married: $10,000/mo married-joint 2 allowances → $477.79/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, MN_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(477.79);
  });

  test("MO: $6,000/mo single 1 allowance → $204.28/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MO_2026, { allowances: 1 })).stateWithholding).toBe(
      204.28,
    );
  });

  test("MO married: $10,000/mo married-joint 2 allowances → $329.22/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, MO_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(329.22);
  });

  test("MS: $6,000/mo single 1 allowance → $174.00/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MS_2026, { allowances: 1 })).stateWithholding).toBe(
      174.0,
    );
  });

  test("MS married: $10,000/mo married-joint 2 allowances → $301.33/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, MS_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(301.33);
  });

  test("MT: $6,000/mo single 1 allowance → $225.59/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, MT_2026, { allowances: 1 })).stateWithholding).toBe(
      225.59,
    );
  });

  test("MT married: $10,000/mo married-joint 2 allowances → $343.88/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, MT_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(343.88);
  });

  test("NC: $6,000/mo single 1 allowance → $193.42/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, NC_2026, { allowances: 1 })).stateWithholding).toBe(
      193.42,
    );
  });

  test("NC married: $10,000/mo married-joint 2 allowances → $348.50/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, NC_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(348.5);
  });

  test("ND: $6,000/mo single 1 allowance → $23.36/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, ND_2026, { allowances: 1 })).stateWithholding).toBe(
      23.36,
    );
  });

  test("ND married: $10,000/mo married-joint 2 allowances → $101.56/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, ND_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(101.56);
  });

  test("NE: $6,000/mo single 1 allowance → $221.83/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, NE_2026, { allowances: 1 })).stateWithholding).toBe(
      221.83,
    );
  });

  test("NE married: $10,000/mo married-joint 2 allowances → $367.78/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, NE_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(367.78);
  });

  test("NH: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, NH_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("NJ: $6,000/mo single 1 allowance → $223.83/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, NJ_2026, { allowances: 1 })).stateWithholding).toBe(
      223.83,
    );
  });

  test("NJ married: $10,000/mo married-joint 2 allowances → $345.67/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, NJ_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(345.67);
  });

  test("NM: $6,000/mo single 1 allowance → $216.39/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, NM_2026, { allowances: 1 })).stateWithholding).toBe(
      216.39,
    );
  });

  test("NM married: $10,000/mo married-joint 2 allowances → $356.68/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, NM_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(356.68);
  });

  test("NV: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, NV_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("NY: $6,000/mo single 1 allowance → $272.45/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, NY_2026, { allowances: 1 })).stateWithholding).toBe(
      272.45,
    );
  });

  test("NY married: $10,000/mo married-joint 2 allowances → $502.12/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, NY_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(502.12);
  });

  test("OH: $6,000/mo single 1 allowance → $103.81/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, OH_2026, { allowances: 1 })).stateWithholding).toBe(
      103.81,
    );
  });

  test("OK: $6,000/mo single 1 allowance → $224.54/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, OK_2026, { allowances: 1 })).stateWithholding).toBe(
      224.54,
    );
  });

  test("OK married: $10,000/mo married-joint 2 allowances → $359.08/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, OK_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(359.08);
  });

  test("OR: $6,000/mo single 1 allowance → $455.28/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, OR_2026, { allowances: 1 })).stateWithholding).toBe(
      455.28,
    );
  });

  test("OR married: $10,000/mo married-joint 2 allowances → $735.56/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, OR_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(735.56);
  });

  test("PA: $6,000/mo single 1 allowance → $184.20/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, PA_2026, { allowances: 1 })).stateWithholding).toBe(
      184.2,
    );
  });

  test("RI: $6,000/mo single 1 allowance → $221.88/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, RI_2026, { allowances: 1 })).stateWithholding).toBe(
      221.88,
    );
  });

  test("SC: $6,000/mo single 1 allowance → $242.82/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, SC_2026, { allowances: 1 })).stateWithholding).toBe(
      242.82,
    );
  });

  test("SD: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, SD_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("TN: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, TN_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("TX: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, TX_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("UT: $6,000/mo single 1 allowance → $267.00/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, UT_2026, { allowances: 1 })).stateWithholding).toBe(
      267.0,
    );
  });

  test("UT married: $10,000/mo married-joint 2 allowances → $445.00/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, UT_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(445.0);
  });

  test("VA: $6,000/mo single 1 allowance → $277.16/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, VA_2026, { allowances: 1 })).stateWithholding).toBe(
      277.16,
    );
  });

  test("VA married: $10,000/mo married-joint 2 allowances → $460.78/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, VA_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(460.78);
  });

  test("VT: $6,000/mo single 1 allowance → $207.26/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, VT_2026, { allowances: 1 })).stateWithholding).toBe(
      207.26,
    );
  });

  test("VT married: $10,000/mo married-joint 2 allowances → $306.44/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, VT_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(306.44);
  });

  test("WA: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, WA_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });

  test("WI: $6,000/mo single 1 allowance → $261.01/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, WI_2026, { allowances: 1 })).stateWithholding).toBe(
      261.01,
    );
  });

  test("WI married: $10,000/mo married-joint 2 allowances → $459.05/mo", () => {
    expect(
      calculatePayroll(stateInput(10000, WI_MARRIED_2026, { allowances: 2 })).stateWithholding,
    ).toBe(459.05);
  });

  test("WV: $6,000/mo single 1 allowance → $200.71/mo", () => {
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, WV_2026, { allowances: 1 })).stateWithholding).toBe(
      200.71,
    );
  });

  test("WY: explicit none — $6,000/mo 1 allowance → $0", () => {
    expect(calculatePayroll(stateInput(6000, WY_2026, { allowances: 1 })).stateWithholding).toBe(0);
  });
});
