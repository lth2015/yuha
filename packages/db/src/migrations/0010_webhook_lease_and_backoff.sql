-- A webhook row had no record of when it was last picked up.
--
-- `claimWebhookEvents` set `status = 'processing'` and selected only
-- 'received' and 'failed'. A worker that died between those two — a deploy, an
-- OOM, a dropped connection — left the row 'processing' with nothing looking
-- at it again. For a Stripe event that is money taken and an entitlement that
-- never landed, and no alert counts it, because the row is not 'failed'.
--
-- The retry budget had the opposite fault: a failed row was taken again by the
-- next pass 100ms later, so ten attempts were spent in about a second. Ten
-- attempts are meant to span an outage.
--
-- Both need one fact nothing recorded: when the row was last taken.
-- `received_at` never moves and `processed_at` is only set at the end.
--
-- Backfilled to `received_at` rather than left NULL: a row already sitting in
-- 'processing' from before this migration would otherwise never satisfy a
-- lease comparison and would stay stuck for exactly the reason this migration
-- exists to fix.
ALTER TABLE webhook_events
  ADD COLUMN attempted_at DATETIME(3) NULL AFTER attempts
-- ;;
UPDATE webhook_events SET attempted_at = received_at WHERE attempted_at IS NULL
-- ;;
-- The claim now orders and filters on (status, attempted_at); the existing
-- index is on (status, received_at) and cannot serve it.
CREATE INDEX webhook_events_claim_idx ON webhook_events (status, attempted_at)
