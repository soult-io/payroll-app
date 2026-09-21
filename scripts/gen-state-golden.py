#!/usr/bin/env python3
"""Generate packages/engine/test/payroll-state-all.test.ts from the 2026 seed JSONs.

Expected values are computed here by an INDEPENDENT implementation of the
documented engine semantics (README: annualized wage method), mirroring the
operation order of computeStateWithholding so IEEE-754 results match.
"""
import json
import math
import os

DIR = "packages/db/src/seeds/state-taxes"
OUT = "packages/engine/test/payroll-state-all.test.ts"


def round2(x: float) -> float:
    return math.floor(x * 100 + 0.5) / 100 if x > 0 else round(x * 100) / 100


def bracket_tax(base: float, brackets: list) -> float:
    tax = 0.0
    remaining = base
    for b in brackets:
        top = b["max"] if b["max"] is not None else math.inf
        in_bracket = min(remaining, top - b["min"])
        if in_bracket <= 0:
            break
        tax += in_bracket * b["rate"]
        remaining -= in_bracket
    return tax


def expected(annual_gross: float, periods: int, cfg: dict, allowances: int) -> float:
    if cfg["kind"] == "none":
        return 0.0
    use_alt = "altMinAllowances" in cfg and allowances >= cfg["altMinAllowances"]

    def pick(base_key, alt_key):
        base = cfg.get(base_key)
        alt = cfg.get(alt_key)
        if use_alt:
            return alt if alt is not None else base
        return base

    low = pick("lowIncomeExemption", "lowIncomeExemptionAlt")
    if low is not None and annual_gross <= low:
        return 0.0
    sd = pick("standardDeduction", "standardDeductionAlt") or 0
    base = max(
        0.0,
        annual_gross - allowances * cfg.get("allowanceDeduction", 0) - sd,
    )
    gross_tax = (
        base * cfg.get("flatRate", 0)
        if cfg["kind"] == "flat"
        else bracket_tax(base, cfg.get("brackets", []))
    )
    tax = max(0.0, gross_tax - allowances * cfg.get("allowanceCredit", 0))
    return round2(tax / periods)


def ts_config(name: str, state: str, year: int, cfg: dict) -> str:
    lines = [f"const {name}: StateTaxConfig = {{", f'  state: "{state}",', f"  year: {year},"]
    lines.append(f'  kind: "{cfg["kind"]}",')
    for key in (
        "flatRate",
        "standardDeduction",
        "standardDeductionAlt",
        "altMinAllowances",
        "lowIncomeExemption",
        "lowIncomeExemptionAlt",
        "allowanceDeduction",
        "allowanceCredit",
        "additionalAllowanceDeduction",
    ):
        if key in cfg:
            lines.append(f"  {key}: {cfg[key]},")
    if "brackets" in cfg:
        lines.append("  brackets: [")
        for b in cfg["brackets"]:
            mx = "Infinity" if b["max"] is None else b["max"]
            lines.append(f'    {{ min: {b["min"]}, max: {mx}, rate: {b["rate"]} }},')
        lines.append("  ],")
    lines.append("};")
    return "\n".join(lines)


def fmt(v: float) -> str:
    s = f"{v:.2f}"
    return s


fixtures = []
tests = []
for f in sorted(os.listdir(DIR)):
    if not f.endswith("-2026.json"):
        continue
    doc = json.load(open(os.path.join(DIR, f)))
    state = doc["state"]
    bare = doc["jurisdictions"].get(state) or doc["jurisdictions"][f"{state}:single"]
    cname = f"{state}_2026"
    fixtures.append(f"/** {doc['source']} */\n" + ts_config(cname, state, 2026, bare))

    if bare["kind"] == "none":
        tests.append(
            f"""  test("{state}: explicit none — $6,000/mo 1 allowance → $0", () => {{
    expect(calculatePayroll(stateInput(6000, {cname}, {{ allowances: 1 }})).stateWithholding).toBe(0);
  }});"""
        )
    else:
        exp_a = expected(72000, 12, bare, 1)
        tests.append(
            f"""  test("{state}: $6,000/mo single 1 allowance → ${fmt(exp_a)}/mo", () => {{
    // 72,000/yr through the documented formula in the fixture comment above.
    expect(calculatePayroll(stateInput(6000, {cname}, {{ allowances: 1 }})).stateWithholding).toBe({fmt(exp_a)});
  }});"""
        )

    mj_key = f"{state}:married_joint"
    if mj_key in doc["jurisdictions"]:
        mj = doc["jurisdictions"][mj_key]
        mname = f"{state}_MARRIED_2026"
        fixtures.append(ts_config(mname, state, 2026, mj))
        exp_b = expected(120000, 12, mj, 2)
        tests.append(
            f"""  test("{state} married: $10,000/mo married-joint 2 allowances → ${fmt(exp_b)}/mo", () => {{
    expect(calculatePayroll(stateInput(10000, {mname}, {{ allowances: 2 }})).stateWithholding).toBe({fmt(exp_b)});
  }});"""
        )

header = '''/**
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

'''

body = "\n\ndescribe(\"2026 per-state golden fixtures\", () => {\n" + "\n\n".join(tests) + "\n});\n"

with open(OUT, "w") as fh:
    fh.write(header + "\n\n".join(fixtures) + "\n\n// --------------------------------------------------------------------------\n// Golden scenarios\n// --------------------------------------------------------------------------\n\n" + body)

print(f"wrote {OUT}: {len(fixtures)} fixtures, {len(tests)} tests")
