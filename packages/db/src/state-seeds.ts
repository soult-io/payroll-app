/**
 * PAY-13 phase 1 — state-withholding seed loader.
 *
 * Loads the documented per-state-year JSON files from seeds/state-taxes/
 * (format: seeds/state-taxes/README.md) and upserts state_tax_configs +
 * state_tax_brackets idempotently. resolveJsonModule inlines the JSON at
 * build time, so dist carries the seed data with no runtime file access.
 *
 * Phase 1 encoded the representative states only — TX (explicit zero),
 * IL (flat), CA (progressive with DE 4 allowance semantics). Phase 2
 * (PAY-13) completes the map: every 2026 income-tax state + DC, plus
 * explicit 'none' rows for all nine no-income-tax states, each with an
 * official-source citation and documented closest-fit exceptions in the
 * file's `source` field (surfaced as the config row's note).
 */

import { and, eq } from "drizzle-orm";
import { stateDepositSchedules, stateTaxBrackets, stateTaxConfigs } from "./schema.js";
import type { SeedDb } from "./seed.js";

import ak2026 from "./seeds/state-taxes/AK-2026.json" with { type: "json" };
import al2026 from "./seeds/state-taxes/AL-2026.json" with { type: "json" };
import ar2026 from "./seeds/state-taxes/AR-2026.json" with { type: "json" };
import az2026 from "./seeds/state-taxes/AZ-2026.json" with { type: "json" };
import ca2026 from "./seeds/state-taxes/CA-2026.json" with { type: "json" };
import co2026 from "./seeds/state-taxes/CO-2026.json" with { type: "json" };
import ct2026 from "./seeds/state-taxes/CT-2026.json" with { type: "json" };
import dc2026 from "./seeds/state-taxes/DC-2026.json" with { type: "json" };
import de2026 from "./seeds/state-taxes/DE-2026.json" with { type: "json" };
import fl2026 from "./seeds/state-taxes/FL-2026.json" with { type: "json" };
import ga2026 from "./seeds/state-taxes/GA-2026.json" with { type: "json" };
import hi2026 from "./seeds/state-taxes/HI-2026.json" with { type: "json" };
import ia2026 from "./seeds/state-taxes/IA-2026.json" with { type: "json" };
import id2026 from "./seeds/state-taxes/ID-2026.json" with { type: "json" };
import il2025 from "./seeds/state-taxes/IL-2025.json" with { type: "json" };
import il2026 from "./seeds/state-taxes/IL-2026.json" with { type: "json" };
import in2026 from "./seeds/state-taxes/IN-2026.json" with { type: "json" };
import ks2026 from "./seeds/state-taxes/KS-2026.json" with { type: "json" };
import ky2026 from "./seeds/state-taxes/KY-2026.json" with { type: "json" };
import la2026 from "./seeds/state-taxes/LA-2026.json" with { type: "json" };
import ma2026 from "./seeds/state-taxes/MA-2026.json" with { type: "json" };
import md2026 from "./seeds/state-taxes/MD-2026.json" with { type: "json" };
import me2026 from "./seeds/state-taxes/ME-2026.json" with { type: "json" };
import mi2026 from "./seeds/state-taxes/MI-2026.json" with { type: "json" };
import mn2026 from "./seeds/state-taxes/MN-2026.json" with { type: "json" };
import mo2026 from "./seeds/state-taxes/MO-2026.json" with { type: "json" };
import ms2026 from "./seeds/state-taxes/MS-2026.json" with { type: "json" };
import mt2026 from "./seeds/state-taxes/MT-2026.json" with { type: "json" };
import nc2026 from "./seeds/state-taxes/NC-2026.json" with { type: "json" };
import nd2026 from "./seeds/state-taxes/ND-2026.json" with { type: "json" };
import ne2026 from "./seeds/state-taxes/NE-2026.json" with { type: "json" };
import nh2026 from "./seeds/state-taxes/NH-2026.json" with { type: "json" };
import nj2026 from "./seeds/state-taxes/NJ-2026.json" with { type: "json" };
import nm2026 from "./seeds/state-taxes/NM-2026.json" with { type: "json" };
import nv2026 from "./seeds/state-taxes/NV-2026.json" with { type: "json" };
import ny2026 from "./seeds/state-taxes/NY-2026.json" with { type: "json" };
import oh2026 from "./seeds/state-taxes/OH-2026.json" with { type: "json" };
import ok2026 from "./seeds/state-taxes/OK-2026.json" with { type: "json" };
import or2026 from "./seeds/state-taxes/OR-2026.json" with { type: "json" };
import pa2026 from "./seeds/state-taxes/PA-2026.json" with { type: "json" };
import ri2026 from "./seeds/state-taxes/RI-2026.json" with { type: "json" };
import sc2026 from "./seeds/state-taxes/SC-2026.json" with { type: "json" };
import sd2026 from "./seeds/state-taxes/SD-2026.json" with { type: "json" };
import tn2026 from "./seeds/state-taxes/TN-2026.json" with { type: "json" };
import tx2025 from "./seeds/state-taxes/TX-2025.json" with { type: "json" };
import tx2026 from "./seeds/state-taxes/TX-2026.json" with { type: "json" };
import ut2026 from "./seeds/state-taxes/UT-2026.json" with { type: "json" };
import va2026 from "./seeds/state-taxes/VA-2026.json" with { type: "json" };
import vt2026 from "./seeds/state-taxes/VT-2026.json" with { type: "json" };
import wa2026 from "./seeds/state-taxes/WA-2026.json" with { type: "json" };
import wi2026 from "./seeds/state-taxes/WI-2026.json" with { type: "json" };
import wv2026 from "./seeds/state-taxes/WV-2026.json" with { type: "json" };
import wy2026 from "./seeds/state-taxes/WY-2026.json" with { type: "json" };

/** One jurisdiction block inside a seed file (see README for semantics). */
export interface StateSeedJurisdiction {
  kind: "none" | "flat" | "progressive";
  flatRate?: number;
  standardDeduction?: number;
  standardDeductionAlt?: number;
  altMinAllowances?: number;
  lowIncomeExemption?: number;
  lowIncomeExemptionAlt?: number;
  allowanceDeduction?: number;
  allowanceCredit?: number;
  additionalAllowanceDeduction?: number;
  brackets?: { min: number; max: number | null; rate: number }[];
}

export interface StateSeedFile {
  state: string;
  taxYear: number;
  source: string;
  jurisdictions: Record<string, StateSeedJurisdiction>;
  depositSchedule?: {
    frequency: "monthly" | "quarterly";
    dueDay: number | null;
    note?: string;
    source?: string;
  };
}

/** Every seed file, in load order. New state-years: add the import + entry. */
export const STATE_SEED_FILES: StateSeedFile[] = [
  tx2025 as StateSeedFile,
  il2025 as StateSeedFile,
  ak2026 as StateSeedFile,
  al2026 as StateSeedFile,
  ar2026 as StateSeedFile,
  az2026 as StateSeedFile,
  ca2026 as StateSeedFile,
  co2026 as StateSeedFile,
  ct2026 as StateSeedFile,
  dc2026 as StateSeedFile,
  de2026 as StateSeedFile,
  fl2026 as StateSeedFile,
  ga2026 as StateSeedFile,
  hi2026 as StateSeedFile,
  ia2026 as StateSeedFile,
  id2026 as StateSeedFile,
  il2026 as StateSeedFile,
  in2026 as StateSeedFile,
  ks2026 as StateSeedFile,
  ky2026 as StateSeedFile,
  la2026 as StateSeedFile,
  ma2026 as StateSeedFile,
  md2026 as StateSeedFile,
  me2026 as StateSeedFile,
  mi2026 as StateSeedFile,
  mn2026 as StateSeedFile,
  mo2026 as StateSeedFile,
  ms2026 as StateSeedFile,
  mt2026 as StateSeedFile,
  nc2026 as StateSeedFile,
  nd2026 as StateSeedFile,
  ne2026 as StateSeedFile,
  nh2026 as StateSeedFile,
  nj2026 as StateSeedFile,
  nm2026 as StateSeedFile,
  nv2026 as StateSeedFile,
  ny2026 as StateSeedFile,
  oh2026 as StateSeedFile,
  ok2026 as StateSeedFile,
  or2026 as StateSeedFile,
  pa2026 as StateSeedFile,
  ri2026 as StateSeedFile,
  sc2026 as StateSeedFile,
  sd2026 as StateSeedFile,
  tn2026 as StateSeedFile,
  tx2026 as StateSeedFile,
  ut2026 as StateSeedFile,
  va2026 as StateSeedFile,
  vt2026 as StateSeedFile,
  wa2026 as StateSeedFile,
  wi2026 as StateSeedFile,
  wv2026 as StateSeedFile,
  wy2026 as StateSeedFile,
];

/** Fail fast on a malformed seed file — seed data is statutory input. */
function validateSeedFile(file: StateSeedFile): void {
  if (!/^[A-Z]{2}$/.test(file.state)) {
    throw new Error(`state seed: bad state code '${file.state}'`);
  }
  for (const [jurisdiction, cfg] of Object.entries(file.jurisdictions)) {
    if (!jurisdiction.startsWith(file.state)) {
      throw new Error(
        `state seed ${file.state}-${file.taxYear}: jurisdiction '${jurisdiction}' mismatch`,
      );
    }
    if (cfg.kind === "flat" && cfg.flatRate === undefined) {
      throw new Error(`state seed ${jurisdiction}-${file.taxYear}: flat kind requires flatRate`);
    }
    if (cfg.kind === "progressive" && (!cfg.brackets || cfg.brackets.length === 0)) {
      throw new Error(
        `state seed ${jurisdiction}-${file.taxYear}: progressive kind requires brackets`,
      );
    }
    if (cfg.kind === "none" && cfg.brackets !== undefined) {
      throw new Error(
        `state seed ${jurisdiction}-${file.taxYear}: 'none' kind must not carry brackets`,
      );
    }
  }
}

/** Config row values for one jurisdiction (undefined seed fields → NULL columns). */
function configValues(file: StateSeedFile, jurisdiction: string, cfg: StateSeedJurisdiction) {
  const str = (v: number | undefined): string | null => (v === undefined ? null : String(v));
  return {
    jurisdiction,
    taxYear: file.taxYear,
    kind: cfg.kind,
    flatRate: str(cfg.flatRate),
    standardDeduction: str(cfg.standardDeduction),
    standardDeductionAlt: str(cfg.standardDeductionAlt),
    altMinAllowances: cfg.altMinAllowances ?? null,
    lowIncomeExemption: str(cfg.lowIncomeExemption),
    lowIncomeExemptionAlt: str(cfg.lowIncomeExemptionAlt),
    allowanceDeduction: str(cfg.allowanceDeduction),
    allowanceCredit: str(cfg.allowanceCredit),
    additionalAllowanceDeduction: str(cfg.additionalAllowanceDeduction),
    note: file.source,
    updatedAt: new Date(),
  };
}

/** Replace the jurisdiction's bracket set with the file's (delete always, insert when present). */
async function replaceBrackets(
  db: SeedDb,
  file: StateSeedFile,
  jurisdiction: string,
  cfg: StateSeedJurisdiction,
): Promise<void> {
  await db
    .delete(stateTaxBrackets)
    .where(
      and(
        eq(stateTaxBrackets.jurisdiction, jurisdiction),
        eq(stateTaxBrackets.taxYear, file.taxYear),
      ),
    );
  if (!cfg.brackets || cfg.brackets.length === 0) return;
  await db.insert(stateTaxBrackets).values(
    cfg.brackets.map((b, i) => ({
      jurisdiction,
      taxYear: file.taxYear,
      ordinal: i + 1,
      minAmount: String(b.min),
      maxAmount: b.max === null ? null : String(b.max),
      rate: String(b.rate),
    })),
  );
}

/**
 * Upsert every jurisdiction in one seed file. Config upserts on
 * (jurisdiction, tax_year); brackets are replaced atomically when present
 * (and deleted when a file drops them), so a corrected file fully
 * re-converges the rows.
 */
export async function seedStateTaxFile(db: SeedDb, file: StateSeedFile): Promise<void> {
  validateSeedFile(file);
  for (const [jurisdiction, cfg] of Object.entries(file.jurisdictions)) {
    const values = configValues(file, jurisdiction, cfg);
    await db
      .insert(stateTaxConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [stateTaxConfigs.jurisdiction, stateTaxConfigs.taxYear],
        set: values,
      });
    await replaceBrackets(db, file, jurisdiction, cfg);
  }
  if (file.depositSchedule) {
    await db
      .insert(stateDepositSchedules)
      .values({
        stateCode: file.state,
        taxYear: file.taxYear,
        frequency: file.depositSchedule.frequency,
        dueDay: file.depositSchedule.dueDay ?? null,
        note: file.depositSchedule.note ?? "",
        source: file.depositSchedule.source ?? "",
      })
      .onConflictDoUpdate({
        target: [stateDepositSchedules.stateCode, stateDepositSchedules.taxYear],
        set: {
          frequency: file.depositSchedule.frequency,
          dueDay: file.depositSchedule.dueDay ?? null,
          note: file.depositSchedule.note ?? "",
          source: file.depositSchedule.source ?? "",
        },
      });
  }
}

/** Load all bundled state-year seed files (idempotent). */
export async function seedStateTaxes(db: SeedDb): Promise<void> {
  for (const file of STATE_SEED_FILES) {
    await seedStateTaxFile(db, file);
  }
}
