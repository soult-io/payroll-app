/**
 * Money math — pure, deterministic cent-rounding helpers.
 *
 * The canonical home for the cents-rounding idiom that used to be open-coded as
 * `Math.round(x * 100) / 100` across payroll.ts and http.ts. Import `round2`
 * instead of re-writing it; the `no-raw-cents-round` Biome plugin bans the raw
 * expression so it cannot re-proliferate. No I/O, no side effects.
 */

/**
 * Round to whole cents (2 decimal places), half-up.
 *
 * Written as two statements rather than the single `Math.round(n * 100) / 100`
 * expression so it is exempt — by construction, not by suppression — from the
 * `no-raw-cents-round` plugin that bans that expression everywhere else.
 */
export function round2(n: number): number {
  const cents = Math.round(n * 100);
  return cents / 100;
}

interface Reconciled {
  totalDeductions: number;
  totalAdjustments: number;
  netPay: number;
}

/**
 * Reconcile net pay from a gross figure, a list of per-line deductions, and an
 * optional list of adjustments.
 *
 * Each input list is assumed already rounded to cents (the callers round every
 * withholding before it reaches here). This sums each list, re-rounds the totals,
 * and derives `netPay = round2(gross − totalDeductions − totalAdjustments)`. The
 * re-round on the summed total is what stops per-line rounding drift from pushing
 * the displayed net a cent above the sum of the printed lines.
 *
 * Both the payroll calculator (calculatePayroll) and the paystub generator
 * (paystubGenerate) route through here, so the gross/deductions/net invariant —
 * `round2(netPay + totalDeductions + totalAdjustments) === gross` — holds by
 * construction rather than by two hand-maintained copies happening to agree.
 */
export function reconcileNet(
  gross: number,
  deductions: number[],
  adjustments: number[] = [],
): Reconciled {
  const totalDeductions = round2(deductions.reduce((sum, d) => sum + d, 0));
  const totalAdjustments = round2(adjustments.reduce((sum, a) => sum + a, 0));
  const netPay = round2(gross - totalDeductions - totalAdjustments);
  return { totalDeductions, totalAdjustments, netPay };
}
