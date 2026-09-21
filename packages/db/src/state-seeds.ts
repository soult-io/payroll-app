/**
 * PAY-13 phase 1 — state-withholding seed loader.
 *
 * Loads the documented per-state-year JSON files from seeds/state-taxes/
 * (format: seeds/state-taxes/README.md) and upserts state_tax_configs +
 * state_tax_brackets idempotently. resolveJsonModule inlines the JSON at
 * build time, so dist carries the seed data with no runtime file access.
 *
 * Phase 1 encodes the representative states only — TX (explicit zero),
 * IL (flat), CA (progressive with DE 4 allowance semantics). Do NOT
 * bulk-add the remaining states here; that is phase 2.
 */

import { and, eq } from "drizzle-orm";
import { stateTaxBrackets, stateTaxConfigs } from "./schema.js";
import type { SeedDb } from "./seed.js";

import ca2026 from "./seeds/state-taxes/CA-2026.json" with { type: "json" };
import il2025 from "./seeds/state-taxes/IL-2025.json" with { type: "json" };
import il2026 from "./seeds/state-taxes/IL-2026.json" with { type: "json" };
import tx2025 from "./seeds/state-taxes/TX-2025.json" with { type: "json" };
import tx2026 from "./seeds/state-taxes/TX-2026.json" with { type: "json" };

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
}

/** Every seed file, in load order. New state-years: add the import + entry. */
export const STATE_SEED_FILES: StateSeedFile[] = [
  tx2025 as StateSeedFile,
  tx2026 as StateSeedFile,
  il2025 as StateSeedFile,
  il2026 as StateSeedFile,
  ca2026 as StateSeedFile,
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
}

/** Load all bundled state-year seed files (idempotent). */
export async function seedStateTaxes(db: SeedDb): Promise<void> {
  for (const file of STATE_SEED_FILES) {
    await seedStateTaxFile(db, file);
  }
}
