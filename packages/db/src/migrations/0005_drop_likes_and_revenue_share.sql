-- 0005 — remove likes and the creator revenue split.
--
-- Two product decisions, applied to the schema:
--
--   * Likes are gone. They existed to rank the public Explore feed, and that
--     feed was removed, so the counter and its source table have no reader
--     left.
--   * The platform sells its own service and does not split licence revenue
--     with creators, so the earnings ledger and the per-sale share rate go.
--
-- What deliberately stays is `track_licenses`: who authored a song, who holds
-- usage rights to it, and what was paid. That record is the authorship proof
-- this product intends to carry on-chain later, so it must outlive the
-- payout machinery that happened to be built alongside it.
--
-- This drops columns and tables, so it is not reversible by a down-migration;
-- the data it removes is engagement and payout accrual, neither of which is
-- a system of record.

-- The check constraint names like_count, so it has to go before the column.
ALTER TABLE tracks
  DROP CONSTRAINT tracks_counts_chk
-- ;;

ALTER TABLE tracks
  DROP COLUMN like_count,
  ADD CONSTRAINT tracks_counts_chk CHECK (play_count >= 0)
-- ;;

DROP TABLE IF EXISTS song_likes
-- ;;

DROP TABLE IF EXISTS creator_earnings
-- ;;

ALTER TABLE track_licenses
  DROP COLUMN creator_share_rate
