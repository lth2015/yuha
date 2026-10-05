-- Failed second-factor attempts, counted against the account rather than the
-- address they came from.
--
-- The existing limit is 12 a minute per IP. A challenge token lives five
-- minutes and is only spent on success, so one challenge can be tried against
-- for its whole life, and an attacker with a handful of addresses multiplies
-- the per-IP allowance by however many they have. Six digits do not survive
-- that for long.
--
-- Counting here instead means the limit follows the account being attacked,
-- which is the thing worth protecting, and no number of addresses raises it.
ALTER TABLE mfa_factors
  ADD COLUMN failed_attempts INT NOT NULL DEFAULT 0 AFTER last_used_at,
  ADD COLUMN locked_until DATETIME(3) NULL AFTER failed_attempts;
