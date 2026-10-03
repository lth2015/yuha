-- A refund could not find the period it paid for.
--
-- `handleRefund` located the order by `stripe_payment_intent_id`, which a
-- `mode: 'subscription'` checkout never has, and then looked only at
-- `source = 'one_time_order'` batches — so a refunded subscription returned the
-- money and left the credits. A renewal is worse still: orders are created by
-- the checkout that opens a subscription, so month two has no order at all and
-- nothing keyed on one could ever reach it.
--
-- The link that does survive is the invoice. A subscription batch's business
-- key is already `<subscription>:<invoice>`, and the payment row written when
-- the period was granted knows the charge. It did not know the invoice, and a
-- `refund.created` carries only a charge — so that one hop was missing, and
-- this is it.
--
-- Nullable because one-time payments have no invoice; they are found by order.
ALTER TABLE payments
  ADD COLUMN stripe_invoice_id VARCHAR(191) NULL AFTER stripe_object_id
-- ;;
CREATE INDEX payments_invoice_idx ON payments (stripe_invoice_id)
