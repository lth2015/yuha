-- Which build made each job (docs/GENERATION_QUALITY_SPEC.md), so the console
-- can show the current version's quality apart from the whole history. NULL
-- for every job before this migration, which then counts only in "all".
ALTER TABLE generation_jobs
  ADD COLUMN build_sha VARCHAR(64) CHARACTER SET ascii NULL AFTER provider_request_key,
  ADD KEY jobs_build_finished_idx (build_sha, finished_at)
