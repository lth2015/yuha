-- How often a subscription bills was never written down.
--
-- `handleInvoicePaid` prefers Stripe's own period end, and when no source has
-- one it grants anyway with an inferred expiry — refusing to grant is the bug
-- those paths were written for, where a paid subscription delivered nothing.
-- The inference was a flat 31 days, which was correct only because every plan
-- in the catalogue happens to be monthly. An annual plan would have been
-- granted a month, and the subscriber would have lost eleven.
--
-- Inferring the cadence from the price key's spelling is exactly the kind of
-- guess this repository keeps finding in itself, so it is a column.
--
-- NULL for one_time, which does not bill again. The CHECK makes a subscription
-- without a cadence impossible rather than merely discouraged: the guess
-- cannot return by somebody forgetting the column.
ALTER TABLE product_catalog
  ADD COLUMN billing_interval VARCHAR(8) NULL AFTER auto_renew
-- ;;
UPDATE product_catalog SET billing_interval = 'month' WHERE kind = 'subscription'
-- ;;
ALTER TABLE product_catalog
  ADD CONSTRAINT product_catalog_interval_chk CHECK (
    billing_interval IS NULL OR billing_interval IN ('month','year')
  )
-- ;;
ALTER TABLE product_catalog
  ADD CONSTRAINT product_catalog_sub_interval_chk CHECK (
    kind <> 'subscription' OR billing_interval IS NOT NULL
  )
