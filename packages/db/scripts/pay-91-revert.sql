-- PAY-91 (spec 23 §10) — EMERGENCY image-rollback helper. Stopgap only.
--
-- STOP THE APP FIRST. No app container (web or scheduler) may be running
-- while this script runs; start the older image only after it commits.
--
-- Run ONLY when an image older than PAY-91 must be re-pinned AFTER the new
-- deposit sync has run. It makes the table look like the old code expects:
--   1. deletes every non-deposited QUARTER row the scheduler wrote (open or
--      superseded — the old code only knows month rows);
--   2. restores superseded MONTH rows to pending/overdue (by due date) with
--      superseded_at NULL — the most recent superseded row per
--      (jurisdiction, period_start), and only where no live month row holds
--      that key (the partial unique index allows one live row).
-- This brings back the pre-fix double count.
--
-- It ABORTS, changing nothing, when:
--   - any quarter row is deposited (roll forward or restore from backup);
--   - a quarter row it would delete has an attachment (the evidence would be lost);
--   - a replaced quarter row has month rows the new code inserted after a
--     quarterly -> monthly change (Case C): there is no consistent pre-fix
--     shape for that period; roll forward.
-- One transaction under an EXCLUSIVE table lock; nothing changes on error.

BEGIN;

LOCK TABLE tax_deposits IN EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tax_deposits WHERE period_kind = 'quarter' AND status = 'deposited'
  ) THEN
    RAISE EXCEPTION 'pay-91-revert: a quarter row is deposited; roll forward or restore from backup';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tax_deposits d
      JOIN deposit_attachments a ON a.deposit_id = d.id
     WHERE d.period_kind = 'quarter' AND d.status IN ('pending', 'overdue', 'superseded')
  ) THEN
    RAISE EXCEPTION 'pay-91-revert: a quarter row to delete has an attachment; roll forward';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tax_deposits q
      JOIN tax_deposits m
        ON m.jurisdiction = q.jurisdiction
       AND m.period_kind = 'month'
       AND m.status <> 'superseded'
       AND m.created_by = 'scheduler'
       AND m.created_at > q.created_at
       AND date_trunc('quarter', m.period_start) = date_trunc('quarter', q.period_start)
     WHERE q.period_kind = 'quarter' AND q.status = 'superseded'
  ) THEN
    RAISE EXCEPTION 'pay-91-revert: month rows replaced a quarter row (monthly change); roll forward';
  END IF;
END $$;

DELETE FROM tax_deposits d
 WHERE d.period_kind = 'quarter'
   AND d.status IN ('pending', 'overdue', 'superseded')
   AND d.created_by = 'scheduler';

UPDATE tax_deposits d
   SET status = CASE WHEN d.due_date < current_date THEN 'overdue' ELSE 'pending' END,
       superseded_at = NULL,
       updated_at = now()
 WHERE d.id IN (
         SELECT DISTINCT ON (s.jurisdiction, s.period_start, s.period_kind) s.id
           FROM tax_deposits s
          WHERE s.status = 'superseded' AND s.period_kind = 'month'
          ORDER BY s.jurisdiction, s.period_start, s.period_kind, s.superseded_at DESC, s.id DESC
       )
   AND NOT EXISTS (
         SELECT 1 FROM tax_deposits l
          WHERE l.status <> 'superseded'
            AND l.jurisdiction = d.jurisdiction
            AND l.period_start = d.period_start
            AND l.period_kind = d.period_kind
       );

COMMIT;
