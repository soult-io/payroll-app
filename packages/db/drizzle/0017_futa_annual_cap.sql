-- Raw SQL migration (hand-written, PAY-26) — not expressible in Drizzle's DSL:
--
-- Defense-in-depth companion to the application-level guard in generateDraft:
-- per-employee annual employer_futa must never exceed futa_wage_cap × futa_rate
-- for the run's tax year (e.g. 7,000 × 0.06 = $420.00). Origin: the PAY-18/22
-- rate misconfiguration (0.6% instead of 6%) silently wrote wrong employer_futa
-- entries on four issued runs; a write-time guard would have caught it.
--
-- BEFORE INSERT on payroll_entries, employer_futa rows only: sum the employee's
-- employer_futa entries on ISSUED runs of the same calendar year (the accrual
-- truth — pending drafts are not counted, mirroring resolvePriorYtdByCategory)
-- plus the new row, and reject when the total exceeds the year's cap. Years
-- without a tax_config row are skipped (the app guard already rejects run
-- creation with no_tax_config before any entry exists). BEFORE (not AFTER) so
-- the sum never double-counts the new row when its own run is already issued.
-- Tolerance: half a cent per period (per-paycheck cent rounding, reconciled as
-- roundingDelta on the 940 worksheet) — the trigger targets material
-- violations like the incident's 10× rate error, not rounding noise.

CREATE OR REPLACE FUNCTION payroll_entries_enforce_futa_annual_cap() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_employee_id integer;
  v_tax_year integer;
  v_cap numeric(12,2);
  v_total numeric(12,2);
  v_periods integer;
BEGIN
  IF NEW.category <> 'employer_futa' THEN
    RETURN NEW;
  END IF;

  SELECT r.employee_id, EXTRACT(YEAR FROM r.period_start)::integer
    INTO v_employee_id, v_tax_year
    FROM "payroll_runs" r
   WHERE r.id = NEW.run_id;

  SELECT round((tc.futa_wage_cap * tc.futa_rate)::numeric, 2)
    INTO v_cap
    FROM "tax_config" tc
   WHERE tc.jurisdiction = 'federal' AND tc.tax_year = v_tax_year;

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(e.amount), 0)::numeric(12,2), COUNT(*)
    INTO v_total, v_periods
    FROM "payroll_entries" e
    JOIN "payroll_runs" r ON r.id = e.run_id
   WHERE e.category = 'employer_futa'
     AND r.employee_id = v_employee_id
     AND r.status = 'issued'
     AND EXTRACT(YEAR FROM r.period_start)::integer = v_tax_year;

  IF v_total + NEW.amount > v_cap + (0.005 * (v_periods + 1))::numeric THEN
    RAISE EXCEPTION 'employer_futa annual cap exceeded for employee % in %: % > cap % (futa_wage_cap × futa_rate)',
      v_employee_id, v_tax_year, v_total + NEW.amount, v_cap;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "payroll_entries_futa_annual_cap"
  BEFORE INSERT ON "payroll_entries"
  FOR EACH ROW EXECUTE FUNCTION payroll_entries_enforce_futa_annual_cap();
