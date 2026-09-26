-- PAY-91 (spec 23 §10) — EMERGENCY image-rollback helper. Stopgap only.
--
-- Run ONLY when an image older than PAY-91 must be re-pinned AFTER the new
-- deposit sync has run. It makes the table look like the old code expects:
--   1. deletes live, non-deposited, attachment-free QUARTER rows the
--      scheduler wrote;
--   2. restores superseded rows to pending/overdue (by due date) with
--      superseded_at NULL — the most recent superseded row per
--      (jurisdiction, period_start, period_kind), and only where no live row
--      holds that key (the partial unique index allows one live row).
-- This brings back the pre-fix double count. If ANY quarter row is
-- deposited it aborts: the only paths then are roll-forward or a restore
-- from backup. One transaction; nothing changes on error.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tax_deposits WHERE period_kind = 'quarter' AND status = 'deposited'
  ) THEN
    RAISE EXCEPTION 'pay-91-revert: a quarter row is deposited; roll forward or restore from backup';
  END IF;
END $$;

DELETE FROM tax_deposits d
 WHERE d.period_kind = 'quarter'
   AND d.status IN ('pending', 'overdue')
   AND d.created_by = 'scheduler'
   AND NOT EXISTS (SELECT 1 FROM deposit_attachments a WHERE a.deposit_id = d.id);

UPDATE tax_deposits d
   SET status = CASE WHEN d.due_date < current_date THEN 'overdue' ELSE 'pending' END,
       superseded_at = NULL,
       updated_at = now()
 WHERE d.id IN (
         SELECT DISTINCT ON (s.jurisdiction, s.period_start, s.period_kind) s.id
           FROM tax_deposits s
          WHERE s.status = 'superseded'
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
