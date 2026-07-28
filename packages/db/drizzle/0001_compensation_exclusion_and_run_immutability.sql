-- Raw SQL migration (hand-written, spec 1) — not expressible in Drizzle's DSL:
--
-- 1. compensation non-overlap: exclusion constraint on
--    daterange(effective_from, effective_to) per employee, so two pay rows for
--    the same employee can never cover overlapping periods (requires btree_gist
--    to gist-index the integer employee_id alongside the range).
-- 2. payroll_runs immutability once issued (D5): a trigger rejects UPDATE on
--    issued runs except the void bookkeeping columns (voided_at, void_reason,
--    status → 'void', updated_at).

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

ALTER TABLE "compensation"
  ADD CONSTRAINT "compensation_no_overlap" EXCLUDE USING gist (
    "employee_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[)') WITH &&
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION payroll_runs_enforce_immutability() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    -- Only void bookkeeping may change on an issued run.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'void' THEN
      RAISE EXCEPTION 'issued payroll run % is immutable (only void allowed)', OLD.id;
    END IF;
    IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.pay_date IS DISTINCT FROM OLD.pay_date
       OR NEW.run_snapshot IS DISTINCT FROM OLD.run_snapshot
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'issued payroll run % is immutable (only void bookkeeping may change)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "payroll_runs_immutable_once_issued"
  BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION payroll_runs_enforce_immutability();
