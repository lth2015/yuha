-- Money that arrived and is not a settled payment.
--
-- This table exists because of a defect, and the defect is worth writing down
-- so the shape is not rebuilt later.
--
-- `chain_transfer_events.(chain_id, tx_hash, log_index)` carries the
-- anti-replay weight for the whole design: one Transfer can be spent on one
-- order, once, ever. An earlier change started writing evidence rows there for
-- money that was NOT being attributed — a transfer from a wallet with nothing
-- open, and a transfer refused by the verifier that nonetheless really paid
-- us. The intention was right (money that arrived must be on the record); the
-- place was not. Claiming the anti-replay key for an unattributed row means
-- the real payment can never be settled afterwards: every later observation
-- answers `already_settled`, the order stays pending, and no console action
-- can attach it. Three independent routine sequences reached that state, each
-- losing a customer's payment permanently and silently.
--
-- So: the record of money arriving and the claim on a payment are two
-- different facts, and they now live in two different tables. Rows here block
-- nothing. A transfer may appear here on one pass and settle normally on a
-- later one, and `settled_at` then says so.
CREATE TABLE stablecoin_orphan_transfers (
  id            CHAR(36) CHARACTER SET ascii NOT NULL,
  chain_id      INT      NOT NULL,
  tx_hash       VARCHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  log_index     INT      NOT NULL,
  token_address VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_address  VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  to_address    VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_atomic VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  block_number  BIGINT UNSIGNED NOT NULL,
  block_hash    VARCHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  block_time    DATETIME(3)  NULL,
  -- Why it is here, in the verifier's own vocabulary, or 'no_open_intent'.
  reason        VARCHAR(48) NOT NULL,
  -- The intent it was refused FOR, when there was one. Not a claim on it:
  -- nothing joins money to an order through this column.
  refused_for_intent_id CHAR(36) CHARACTER SET ascii NULL,
  observed_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- Set when this transfer later settled normally, by the scan or by a
  -- customer reporting the hash. The row is kept: it is the record of what
  -- the system thought at the time.
  settled_at    DATETIME(3) NULL,
  -- Set when an operator attached it to an order by hand.
  claimed_at    DATETIME(3) NULL,
  claimed_by    CHAR(36) CHARACTER SET ascii NULL,
  claimed_order_id CHAR(36) CHARACTER SET ascii NULL,
  -- Set when an operator decided it is not ours to deliver against (a refund
  -- is then owed, and that is a person's job — see docs/STABLECOIN_V1_PLAN.md).
  dismissed_at  DATETIME(3) NULL,
  dismissed_by  CHAR(36) CHARACTER SET ascii NULL,
  note          TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY stablecoin_orphan_transfers_uk (chain_id, tx_hash, log_index),
  KEY stablecoin_orphan_transfers_open_idx (settled_at, claimed_at, dismissed_at, block_number),
  KEY stablecoin_orphan_transfers_from_idx (chain_id, from_address),
  CONSTRAINT stablecoin_orphan_transfers_amount_chk CHECK (amount_atomic REGEXP '^[0-9]{1,78}$'),
  CONSTRAINT stablecoin_orphan_transfers_addr_chk CHECK (
    token_address = LOWER(token_address) AND from_address = LOWER(from_address) AND to_address = LOWER(to_address))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- A payment an operator refused in review is money we are holding and should
-- not keep. `resolveReview({state:'cancelled'})` changed a state and nothing
-- else, so the money left every queue with no record that anything was owed.
-- There is no automated stablecoin refund by design (§13): the point of this
-- column is that the obligation is written down and listable.
ALTER TABLE chain_transfer_events
  ADD COLUMN refund_owed_at DATETIME(3) NULL AFTER finalized_at
-- ;;

-- One order, one live payment slot.
--
-- `stablecoin_intents_open_uk` made one WALLET hold at most one open intent,
-- which was taken to mean one order could hold at most one. It does not: a
-- customer with two verified wallets could quote the same order twice and hold
-- two live slots, and paying both took two payments for one delivery — the
-- second landing in no operator queue at all. The column is NULL for a closed
-- intent, exactly like `open_key`, because MySQL has no partial unique index
-- and allows any number of NULLs in a unique column.
ALTER TABLE stablecoin_intents
  ADD COLUMN order_open_key CHAR(36) CHARACTER SET ascii NULL AFTER open_key,
  ADD UNIQUE KEY stablecoin_intents_order_open_uk (order_open_key)
-- ;;

-- Backfill: every intent still holding a wallet slot is also holding its
-- order's slot. Written as the same condition the application uses rather than
-- on `state`, so an intent in an unexpected state cannot slip through.
UPDATE stablecoin_intents SET order_open_key = order_id WHERE open_key IS NOT NULL
