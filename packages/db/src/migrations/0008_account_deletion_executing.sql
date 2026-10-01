-- 0008 — `executing` is a state, and `failed` is an open request.
--
-- Two holes opened in 0007 the moment the erasure became retryable:
--
-- 1. `claimAccountDeletion` wrote `status = 'executed'` BEFORE doing any work,
--    so a worker killed mid-erasure left a row that reads exactly like a
--    success — `executed`, `outcome` NULL — and that no claim would ever pick
--    up again. A half-erased account, and nobody could tell.
--
-- 2. The `open_user_id` generated column counted only `requested` and
--    `verified` as open, under a comment promising "one open request per
--    account". A `failed` row is open work by behaviour — it is claimable and
--    it leaves objects behind — so a user whose erasure failed could open a
--    second request and have it verified and executed while an operator
--    retried the first. Two concurrent erasures of one account, which is the
--    race the index was written to prevent.
--
-- Forward-fixed in a new file rather than by editing 0007, which is
-- checksum-tracked (§12.3).

ALTER TABLE account_deletions
  DROP CONSTRAINT account_deletions_status_chk
-- ;;

ALTER TABLE account_deletions
  ADD CONSTRAINT account_deletions_status_chk CHECK (status IN
    ('requested','verified','executing','executed','failed','cancelled'))
-- ;;

-- The index depends on the column, so it goes first.
ALTER TABLE account_deletions
  DROP INDEX account_deletions_open_uk
-- ;;

ALTER TABLE account_deletions
  DROP COLUMN open_user_id
-- ;;

ALTER TABLE account_deletions
  ADD COLUMN open_user_id CHAR(36) CHARACTER SET ascii GENERATED ALWAYS AS
    (CASE WHEN status IN ('requested','verified','executing','failed') THEN user_id END) STORED
-- ;;

ALTER TABLE account_deletions
  ADD UNIQUE KEY account_deletions_open_uk (open_user_id)
