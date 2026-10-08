-- Credits an operator hands out, told apart from credits we owe.
--
-- `POST /v1/admin/users/:id/compensate` has existed since the first release
-- and it is a make-good: a generation failed, or a batch expired on us, so the
-- customer gets the songs back. It is capped at 20 units and dated by
-- EXPIRED_BATCH_COMPENSATION_DAYS, and in the ledger it says `compensation`,
-- which is a cost we caused.
--
-- Giving fifty credits to a friend is a different thing with the same
-- mechanism. Routing it through `compensation` would say in the books that we
-- broke something we did not, and routing it through `manual_adjustment` —
-- which is what the seed uses for demo accounts — would put a deliberate
-- giveaway in the same bucket as fixture data and any future ad-hoc repair.
-- Neither can answer "how much have we given away", which is a question
-- somebody will ask the first time the provider bill is larger than the
-- revenue.
--
-- So: a source of its own. A CHECK list is the kind of explicit list this
-- repository has been bitten by five times, so note that the zod enum in
-- packages/contracts/src/enums.ts carries the same six values and
-- tests/operator-grant.test.ts holds them against each other.
--
-- MySQL cannot alter a CHECK in place; it is dropped and rewritten.
ALTER TABLE entitlement_batches
  DROP CONSTRAINT entitlement_batches_source_chk
-- ;;
ALTER TABLE entitlement_batches
  ADD CONSTRAINT entitlement_batches_source_chk CHECK (source IN
    ('one_time_order','subscription_period','promo_trial','compensation',
     'manual_adjustment','operator_gift'))
