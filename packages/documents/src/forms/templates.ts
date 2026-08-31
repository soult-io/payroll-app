/**
 * Bundled IRS form templates (PAY-19, D2): the official AcroForm PDFs live in
 * the repo per tax year under assets/forms/<year>/ — no runtime fetch. Each
 * registry entry pins the SHA-256 of the vetted file so a swapped/corrupted
 * asset fails loudly instead of silently filling the wrong form.
 *
 * Adding a new tax year = drop fw2.pdf + fw3.pdf into assets/forms/<year>/,
 * add a registry entry with its checksums, and (if the IRS moved fields) a
 * new field-map module next to field-map-2025.ts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ASSETS_ROOT = new URL("../../assets/forms/", import.meta.url);

interface TemplateEntry {
  fw2Sha256: string;
  fw3Sha256: string;
}

const TEMPLATES: Record<number, TemplateEntry> = {
  // Official 2025 revisions (irs.gov/pub/irs-prior/fw2--2025.pdf, fw3--2025.pdf).
  2025: {
    fw2Sha256: "6a52ad63693de54220a3326b22c4d0fb34f4c25084366537087312975a55ae96",
    fw3Sha256: "3e2bbe8e8654acdbc3249b36991f41ec841e9c132cf1ea45bbce5034ed12eb13",
  },
};

/** Tax years with a bundled official template. */
export function templateYears(): number[] {
  return Object.keys(TEMPLATES).map(Number);
}

/**
 * Load + verify a bundled template. Throws when the year has no bundled
 * template or the file's checksum does not match the vetted bytes.
 */
export function templateBytes(year: number, form: "fw2" | "fw3"): Buffer {
  const entry = TEMPLATES[year];
  if (!entry) {
    throw new Error(
      `no bundled IRS ${form} template for tax year ${year} (bundled: ${templateYears().join(", ")})`,
    );
  }
  const bytes = readFileSync(new URL(`${year}/${form}.pdf`, ASSETS_ROOT));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const expected = form === "fw2" ? entry.fw2Sha256 : entry.fw3Sha256;
  if (sha !== expected) {
    throw new Error(`bundled ${form}.pdf for ${year} failed checksum (got ${sha})`);
  }
  return bytes;
}
