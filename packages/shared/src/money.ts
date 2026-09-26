/**
 * Shared money / formatting constants (spec 1 cross-cutting rules).
 * Money math itself lives ONLY in @payroll/engine (round2, reconcileNet) —
 * these are display/wire conventions shared by server + web.
 */

/** DB money columns are NUMERIC(12,2); rates NUMERIC(6,5). */
export const MONEY_PRECISION = 12;
export const MONEY_SCALE = 2;
export const RATE_PRECISION = 6;
export const RATE_SCALE = 5;

/** Rounding mode for all money math is half-up, defined once in @payroll/engine. */
export const ROUNDING_MODE = "half-up" as const;

/** Display timezone for dates; the DB stores TIMESTAMPTZ (spec 1). */
export const APP_TIMEZONE = "Europe/Madrid";

/** Single display currency for v1 (multi-currency is a D12 exclusion). */
export const CURRENCY = "USD";

/** Format cents-precision numbers for display, e.g. 1234.56 → "$1,234.56". */
export function formatMoney(amount: number, currency: string = CURRENCY): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

/**
 * PAY-91 (spec 23 §6): exact conversion between a NUMERIC(12,2) string and
 * integer cents. No floats: "123.45" → 12345. Accepts an optional leading
 * minus and 0–2 decimals ("5", "5.5", "5.50"); rejects anything else.
 */
export function parseCents(value: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`parseCents: not a money string: ${JSON.stringify(value)}`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  const c = whole * 100 + frac;
  if (!Number.isSafeInteger(c)) throw new Error(`parseCents: out of range: ${value}`);
  return m[1] && c !== 0 ? -c : c;
}

/** Integer cents → "123.45" (the NUMERIC(12,2) wire form). */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`formatCents: not integer cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
