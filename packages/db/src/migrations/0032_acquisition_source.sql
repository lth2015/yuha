-- The campaign link an account first arrived through (docs/ATTRIBUTION_SPEC.md),
-- set once, within a day of sign-up, from what the browser kept of `?src=`.
-- A short tag such as "x-xmas-1", never anything about the person.
ALTER TABLE users
  ADD COLUMN acquisition_source VARCHAR(48) NULL AFTER marketing_opt_in,
  ADD KEY users_source_created_idx (acquisition_source, created_at)
