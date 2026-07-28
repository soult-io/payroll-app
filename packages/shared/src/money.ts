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

/** Format cents-precision numbers for display, e.g. 3463.12 → "$3,463.12". */
export function formatMoney(amount: number, currency: string = CURRENCY): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}
