-- A credit given back when a problem report is resolved (docs/FAILURE_COMPENSATION_SPEC.md).
--
-- The batch is the compensation itself, written to the ledger against the
-- song's generation job; these two columns only let the report say so to its
-- owner without a join through the ledger. NULL when nothing was given.
ALTER TABLE issue_reports
  ADD COLUMN compensation_batch_id CHAR(36) CHARACTER SET ascii NULL AFTER resolved_at,
  ADD COLUMN compensated_units INT NULL AFTER compensation_batch_id,
  ADD KEY issue_reports_compensation_idx (compensation_batch_id)
