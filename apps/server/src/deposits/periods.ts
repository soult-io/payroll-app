/**
 * Pure period and due-date helpers for tax deposits (PAY-9 federal, PAY-48
 * state schedules). No DB, no clock. Shared by the deposit service and the
 * PAY-91 period-transition planner (transition.ts). All date math in UTC.
 */

/** periodKind distinguishes monthly (m12) from quarterly (q4) deposits. */
export type PeriodKind = "month" | "quarter";

/** A state's deposit schedule for one tax year (state_deposit_schedules row). */
export interface StateSchedule {
  frequency: "monthly" | "quarterly";
  dueDay: number | null;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** First of the month as "YYYY-MM-DD" (the period key for a deposit month). */
export function periodStartFor(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`;
}

/**
 * Due date for the deposit covering `year`-`month`: the 15th of the FOLLOWING
 * month, rolled forward to the next business day when it lands on a weekend
 * (federal-holiday roll is out of scope for V1). All math in UTC.
 */
export function dueDateFor(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 15)); // month is 1-based → next month
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** "August 2026" / "Q3 2026" — display label for a deposit period (stored period_kind). */
export function periodLabel(periodStart: string, kind: PeriodKind = "month"): string {
  if (kind === "quarter") {
    const year = Number(periodStart.slice(0, 4));
    const q = quarterOfMonth(Number(periodStart.slice(5, 7)));
    return `Q${q} ${year}`;
  }
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  return `${MONTH_NAMES[month - 1] ?? periodStart} ${year}`;
}

/**
 * quarterOfMonth: map a month (1-12) to its quarter (1-4).
 * Jan-Mar = 1, Apr-Jun = 2, Jul-Sep = 3, Oct-Dec = 4.
 */
export function quarterOfMonth(month: number): number {
  return Math.ceil(month / 3);
}

/**
 * statePeriodStartFor: determine the period start for a given (year, month)
 * based on the schedule's frequency. Monthly or no schedule → monthly period
 * (first of the month). Quarterly → first of the quarter's first month.
 */
export function statePeriodStartFor(
  schedule: { frequency: "monthly" | "quarterly" } | null,
  year: number,
  month: number,
): string {
  if (!schedule || schedule.frequency === "monthly") {
    return periodStartFor(year, month);
  }
  const q = quarterOfMonth(month);
  const firstMonthOfQuarter = (q - 1) * 3 + 1;
  return periodStartFor(year, firstMonthOfQuarter);
}

/**
 * stateDueDateFor: compute the due date for a period start, given a schedule.
 * No schedule → federal convention (monthly, 15th following month, weekend roll).
 * Monthly → dueDay of following month (or last day if NULL).
 * Quarterly → dueDay of month following quarter's end (or last day if NULL).
 * All math UTC, weekend roll-forward only.
 */
export function stateDueDateFor(
  schedule: { frequency: "monthly" | "quarterly"; dueDay?: number | null } | null,
  _year: number,
  periodStart: string,
): string {
  // Use the year from periodStart, not the passed year parameter
  const year = Number(periodStart.slice(0, 4));
  if (!schedule) {
    const m = Number(periodStart.slice(5, 7));
    return dueDateFor(year, m);
  }
  if (schedule.frequency === "monthly") {
    const month = Number(periodStart.slice(5, 7));
    const dueMonth = month === 12 ? 1 : month + 1;
    const dueYear = month === 12 ? year + 1 : year;
    const dueDay = schedule.dueDay ?? daysInMonth(dueYear, dueMonth);
    return dueDateForDay(dueYear, dueMonth, dueDay);
  }
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const lastMonthOfQuarter = quarter * 3;
  const dueMonth = lastMonthOfQuarter === 12 ? 1 : lastMonthOfQuarter + 1;
  const dueYear = lastMonthOfQuarter === 12 ? year + 1 : year;
  const dueDay = schedule.dueDay ?? daysInMonth(dueYear, dueMonth);
  return dueDateForDay(dueYear, dueMonth, dueDay);
}

function daysInMonth(year: number, month: number): number {
  // month is 1-indexed (1=Jan, 12=Dec)
  // Use UTC to avoid timezone issues
  // Date(year, month, 0) gives last day of (month-1) in 0-indexed terms
  // daysInMonth(2026, 10) = last day of October = 31
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate();
}

function dueDateForDay(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}
