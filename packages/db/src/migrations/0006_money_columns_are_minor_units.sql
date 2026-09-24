-- 0006 — money columns say what they hold.
--
-- `amount_jpy` was named when the launch catalogue was priced in yen. The
-- catalogue is priced in USD and the column has always stored *minor units*,
-- so a row reading `amount_jpy = 499` means $4.99, not ¥499.
--
-- That is a 100× error waiting for its moment: JPY is a zero-decimal
-- currency, so the stored integer IS the amount, while USD needs dividing by
-- 100. Anyone reading a column called `amount_jpy` reasonably assumes the
-- former. One such division had already been written open-coded in the web
-- client, correct only by the accident of the catalogue being USD today.
--
-- Every one of these already carries a sibling `currency` column, which is
-- the real source of truth for how to render the number.
--
-- Rename only: no values change, and MySQL's CHANGE keeps the column
-- definitions byte-for-byte. The CHECK constraints reference the old names,
-- so they are dropped and re-added around the rename.

ALTER TABLE product_catalog
  DROP CONSTRAINT product_catalog_amount_chk
-- ;;

ALTER TABLE product_catalog
  CHANGE COLUMN amount_jpy amount_minor INT NOT NULL,
  ADD CONSTRAINT product_catalog_amount_chk CHECK (amount_minor >= 0 AND units > 0)
-- ;;

ALTER TABLE orders
  DROP CONSTRAINT orders_amount_chk
-- ;;

ALTER TABLE orders
  CHANGE COLUMN amount_jpy amount_minor INT NOT NULL,
  CHANGE COLUMN refunded_amount_jpy refunded_amount_minor INT NOT NULL DEFAULT 0,
  ADD CONSTRAINT orders_amount_chk CHECK (amount_minor >= 0 AND refunded_amount_minor >= 0)
-- ;;

ALTER TABLE payments
  CHANGE COLUMN amount_jpy amount_minor INT NOT NULL,
  CHANGE COLUMN fee_jpy fee_minor INT NOT NULL DEFAULT 0,
  CHANGE COLUMN net_jpy net_minor INT NOT NULL DEFAULT 0
