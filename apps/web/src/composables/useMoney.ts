/**
 * Single money/number formatting composable (frontend spec UX conventions):
 * money always $1,234.56 via one place; rates as percentages.
 */

import { formatMoney } from "@payroll/shared";

export function useMoney() {
  /** 1234.56 → "$1,234.56". Accepts numeric strings from NUMERIC columns. */
  function money(amount: number | string | null | undefined): string {
    if (amount === null || amount === undefined) return "—";
    const n = typeof amount === "string" ? Number(amount) : amount;
    if (Number.isNaN(n)) return "—";
    return formatMoney(n);
  }

  /** 0.062 → "6.2%" (NUMERIC(6,5) rates are fractions). */
  function percent(rate: number | string | null | undefined, digits = 3): string {
    if (rate === null || rate === undefined) return "—";
    const n = typeof rate === "string" ? Number(rate) : rate;
    if (Number.isNaN(n)) return "—";
    return `${(n * 100).toFixed(digits).replace(/\.?0+$/, "")}%`;
  }

  return { money, percent };
}
