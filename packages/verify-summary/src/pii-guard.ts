/**
 * Spec 17 §1.3 — PII-free backstop.
 *
 * The summary only ever carries test titles, file paths, durations and git/run
 * metadata — never payroll form fields. That STRUCTURE is the real guarantee.
 * This guard is defense-in-depth for the accidental-literal case: a stray
 * PII-shaped string in a test title would otherwise ride into a site that is
 * only access-gated. It scans every string leaf and fails emission on a match.
 *
 * Scanned: emails at non-reserved domains, US SSN, EIN, US phone numbers.
 * Raw bank/account digit runs are deliberately NOT scanned — they collide with
 * timestamps and durations; the structural guarantee covers them.
 */

/** RFC-2606 / reserved documentation domains never count as real PII. */
const RESERVED_TLDS = [".test", ".example", ".invalid", ".localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

// Bounded, unambiguous (dot only as a literal separator, never inside a label)
// so the match is linear — avoids the polynomial-ReDoS a naive email regex has
// on uncontrolled input. Group 1 is the whole domain. Lengths follow RFC limits.
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,9}\.[a-z]{2,24})/gi;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN_RE = /\b\d{2}-\d{7}\b/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

export type PiiKind = "email" | "ssn" | "ein" | "phone";

export interface PiiFinding {
  /** Dotted path to the offending string, e.g. "suites.0.tests.3.name". */
  path: string;
  kind: PiiKind;
  match: string;
}

function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (RESERVED_DOMAINS.includes(d)) return true;
  return (
    RESERVED_TLDS.some((tld) => d.endsWith(tld)) ||
    RESERVED_DOMAINS.some((r) => d.endsWith(`.${r}`))
  );
}

function scanString(value: string, path: string): PiiFinding[] {
  const found: PiiFinding[] = [];
  for (const m of value.matchAll(EMAIL_RE)) {
    const domain = m[1];
    if (domain && !isReservedDomain(domain)) found.push({ path, kind: "email", match: m[0] });
  }
  for (const m of value.matchAll(SSN_RE)) found.push({ path, kind: "ssn", match: m[0] });
  for (const m of value.matchAll(EIN_RE)) found.push({ path, kind: "ein", match: m[0] });
  for (const m of value.matchAll(PHONE_RE)) found.push({ path, kind: "phone", match: m[0] });
  return found;
}

function walk(value: unknown, path: string, out: PiiFinding[]): void {
  if (typeof value === "string") {
    out.push(...scanString(value, path));
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walk(item, path ? `${path}.${i}` : String(i), out);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, out);
  }
}

/** All PII-shaped strings in the value (empty ⇒ clean). */
export function findPii(value: unknown): PiiFinding[] {
  const out: PiiFinding[] = [];
  walk(value, "", out);
  return out;
}

/** Throw if the value carries any PII-shaped string. */
export function assertPiiFree(value: unknown): void {
  const findings = findPii(value);
  if (findings.length === 0) return;
  const lines = findings.map((f) => `  ${f.path}: ${f.kind} "${f.match}"`).join("\n");
  throw new Error(`verify summary carries ${findings.length} PII-shaped value(s):\n${lines}`);
}
