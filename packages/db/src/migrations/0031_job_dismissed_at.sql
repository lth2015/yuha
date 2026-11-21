-- 「不要了」 on a generation that ended without a song (docs/TASK_RECOVERY_SPEC.md).
-- Hides it from its owner's lists of unfinished generations; the job and its
-- ledger are untouched. NULL for every job before this migration.
ALTER TABLE generation_jobs
  ADD COLUMN dismissed_at DATETIME(3) NULL AFTER finished_at
