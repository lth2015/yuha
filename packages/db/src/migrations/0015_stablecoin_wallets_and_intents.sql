-- Stablecoin payments v1, the tables this slice and the scanner need.
--
-- Deliberately NOT every table the specification lists: refunds and
-- accounting_events arrive with the code that writes them. An empty table is
-- a declared capability with nothing behind it, which is the failure this
-- project keeps finding in its own work.
--
-- Amounts are VARCHAR(78) ascii, digits only, never a float and never an INT.
-- A uint256 is 78 decimal digits and MySQL's DECIMAL stops at 65, so a numeric
-- column could not record an observed on-chain value at all — and an observed
-- value has to be recordable even when it is absurd, because refusing to write
-- down what happened is how evidence goes missing. Application code reads
-- these as BigInt; reporting CASTs, and the CAST is safe for our own amounts
-- (an 18-decimal token at 10^47 whole units is not a number this business
-- reaches) but is not relied on for comparison.

-- A note on COLLATE ascii_bin, which every address, hash and amount column
-- below carries: the default for CHARACTER SET ascii is ascii_general_ci, and
-- it is case-INSENSITIVE. Under it `CHECK (payer = LOWER(payer))` is true for
-- every value, including '0x...AAA' — the constraint reads like a guarantee
-- and enforces nothing. It was written that way first and the probe that was
-- supposed to catch it reported no error, which looked like the check passing.
-- Binary collation makes the comparison compare case, and makes address
-- lookups case-sensitive, so callers must lowercase before querying. That is
-- the intended contract rather than a side effect.

-- Which channel an order is being paid through. NULL means the card path, so
-- every existing row keeps its current meaning and nothing has to be
-- backfilled. One active channel per order (§9) is enforced in the service:
-- the column records the choice, it does not by itself prevent a second one.
ALTER TABLE orders
  ADD COLUMN payment_method VARCHAR(24) NULL AFTER kind,
  ADD CONSTRAINT orders_payment_method_chk
    CHECK (payment_method IS NULL OR payment_method IN ('card', 'stablecoin'))
-- ;;

-- A one-time challenge a wallet signs to prove control. Holds no key material
-- and no signature — only what was asked and whether it was answered.
CREATE TABLE wallet_challenges (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  -- The random part of the SIWE message. Single use: `consumed_at` is set by a
  -- conditional UPDATE, so two verifications cannot both spend one nonce.
  nonce       VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Echoed back into the message and checked on verify, so a signature
  -- harvested by another site cannot be replayed here.
  domain      VARCHAR(255) NOT NULL,
  uri         VARCHAR(512) NOT NULL,
  chain_id    INT          NOT NULL,
  -- The address the client said it was about to sign with. Advisory: the
  -- address that counts is the one recovered from the signature.
  claimed_address VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NULL,
  issued_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at  DATETIME(3)  NOT NULL,
  consumed_at DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY wallet_challenges_nonce_uk (nonce),
  KEY wallet_challenges_user_idx (user_id, issued_at DESC),
  CONSTRAINT wallet_challenges_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- A wallet that has proved control to this account. Stored lowercased so a
-- comparison cannot depend on casing; the checksummed form is derived for
-- display and never stored as the key.
CREATE TABLE verified_wallets (
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  chain_id    INT      NOT NULL,
  address     VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Which challenge proved it, so the proof can be audited later.
  challenge_id CHAR(36) CHARACTER SET ascii NULL,
  verified_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  PRIMARY KEY (user_id, chain_id, address),
  -- One account per address per chain. Two people cannot both claim the same
  -- wallet, because then an incoming transfer would match two orders and the
  -- one-open-intent rule below would be enforcing nothing.
  UNIQUE KEY verified_wallets_address_uk (chain_id, address),
  CONSTRAINT verified_wallets_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT verified_wallets_address_chk CHECK (address = LOWER(address))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- A price, fixed for ten minutes, with everything needed to defend it later.
CREATE TABLE stablecoin_quotes (
  id             CHAR(36) CHARACTER SET ascii NOT NULL,
  order_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  token_key      VARCHAR(16)  NOT NULL,
  chain_id       INT          NOT NULL,
  token_address  VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_decimals TINYINT      NOT NULL,
  receiver       VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payer          VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- JPY list price this quote was computed from, so a catalogue change later
  -- cannot alter what the customer was asked to pay.
  price_jpy      INT          NOT NULL,
  amount_atomic  VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The rate exactly as the source gave it, plus where and when it came from.
  -- NULL for JPYC, which is quoted 1:1 as a pricing policy and consults no
  -- rate at all — a stored 1.0 would read as a redemption claim.
  rate_text      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  rate_provider  VARCHAR(64) NULL,
  rate_source_at DATETIME(3) NULL,
  rate_observed_at DATETIME(3) NULL,
  rounded_up     TINYINT(1)  NOT NULL DEFAULT 0,
  -- Height the scanner starts looking from for this quote.
  start_block    BIGINT UNSIGNED NOT NULL,
  -- Whitelist/receiver/rule version in force when this was quoted. Changing
  -- configuration must not change how an existing order is verified.
  config_version INT          NOT NULL,
  expires_at     DATETIME(3)  NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY stablecoin_quotes_order_idx (order_id, created_at DESC),
  KEY stablecoin_quotes_payer_idx (chain_id, payer, created_at DESC),
  CONSTRAINT stablecoin_quotes_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT stablecoin_quotes_user_fk  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT stablecoin_quotes_amount_chk CHECK (amount_atomic REGEXP '^[0-9]{1,78}$'),
  CONSTRAINT stablecoin_quotes_price_chk  CHECK (price_jpy > 0),
  CONSTRAINT stablecoin_quotes_addr_chk
    CHECK (receiver = LOWER(receiver) AND payer = LOWER(payer) AND token_address = LOWER(token_address))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- The binding between a payer and one order, and the reason this slice exists.
--
-- `open_key` is 'chainId:payer' while the intent is unresolved and NULL once it
-- is settled, expired or cancelled. MySQL has no partial unique index, but it
-- does allow any number of NULLs in a unique column — so this gives exactly
-- "at most one open intent per wallet per chain" as a constraint the database
-- enforces, rather than a check in application code that a race can step over.
-- Without it, two open quotes for one wallet make an incoming transfer
-- ambiguous, and ambiguity is what the whole no-receiving-contract design has
-- to avoid.
--
-- `predicted_nonce` is what the account's transaction count was when the
-- transfer was prepared. It is evidence, not a reservation: a nonce in someone
-- else's wallet cannot be reserved, and any other dapp the owner touches while
-- the quote is open consumes it. See docs/STABLECOIN_V1_PLAN.md §1.
CREATE TABLE stablecoin_intents (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  quote_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  order_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  chain_id    INT      NOT NULL,
  payer       VARCHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  predicted_nonce INT  NULL,
  state       VARCHAR(16) NOT NULL DEFAULT 'quoted',
  open_key    VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  prepared_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY stablecoin_intents_quote_uk (quote_id),
  UNIQUE KEY stablecoin_intents_open_uk (open_key),
  KEY stablecoin_intents_payer_idx (chain_id, payer, created_at DESC),
  KEY stablecoin_intents_order_idx (order_id),
  CONSTRAINT stablecoin_intents_quote_fk FOREIGN KEY (quote_id) REFERENCES stablecoin_quotes (id) ON DELETE CASCADE,
  CONSTRAINT stablecoin_intents_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT stablecoin_intents_state_chk CHECK (state IN
    ('quoted','prepared','submitted','confirming','confirmed','expired','cancelled','review')),
  CONSTRAINT stablecoin_intents_payer_chk CHECK (payer = LOWER(payer))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- Every hash seen for one intent, including replacements. Append-only: a
-- speed-up that replaces a hash does not overwrite the evidence of the first.
CREATE TABLE stablecoin_attempts (
  id            CHAR(36) CHARACTER SET ascii NOT NULL,
  intent_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  tx_hash       VARCHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The attempt this one replaced at the same nonce, when that is known.
  replaces_id   CHAR(36) CHARACTER SET ascii NULL,
  nonce         INT          NULL,
  receipt_status TINYINT     NULL,
  block_number  BIGINT UNSIGNED NULL,
  block_hash    VARCHAR(66) CHARACTER SET ascii COLLATE ascii_bin NULL,
  block_time    DATETIME(3)  NULL,
  discovered_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finalized_at  DATETIME(3)  NULL,
  -- Why it was refused or held, from the verifier's own vocabulary.
  verdict       VARCHAR(32)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY stablecoin_attempts_intent_hash_uk (intent_id, tx_hash),
  KEY stablecoin_attempts_hash_idx (tx_hash),
  CONSTRAINT stablecoin_attempts_intent_fk FOREIGN KEY (intent_id) REFERENCES stablecoin_intents (id) ON DELETE CASCADE,
  CONSTRAINT stablecoin_attempts_replaces_fk FOREIGN KEY (replaces_id) REFERENCES stablecoin_attempts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- The payment evidence, and the thing that makes a claim unrepeatable.
--
-- (chain_id, tx_hash, log_index) unique is what stops a copied public hash and
-- stops one transfer being spent on two orders. It carries the anti-replay
-- weight for the whole design, which is why it is a database constraint and
-- not a lookup.
CREATE TABLE chain_transfer_events (
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
  -- Still the block at that height, as of the last check.
  canonical     TINYINT(1)  NOT NULL DEFAULT 1,
  finalized_at  DATETIME(3) NULL,
  -- The intent this was credited to, once one is established. NULL means seen
  -- and not yet attributed — which is a state worth having rather than a row
  -- we declined to write.
  intent_id     CHAR(36) CHARACTER SET ascii NULL,
  observed_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY chain_transfer_events_evidence_uk (chain_id, tx_hash, log_index),
  KEY chain_transfer_events_to_idx (chain_id, to_address, block_number),
  KEY chain_transfer_events_from_idx (chain_id, from_address, block_number),
  KEY chain_transfer_events_intent_idx (intent_id),
  CONSTRAINT chain_transfer_events_intent_fk FOREIGN KEY (intent_id) REFERENCES stablecoin_intents (id),
  CONSTRAINT chain_transfer_events_amount_chk CHECK (amount_atomic REGEXP '^[0-9]{1,78}$'),
  CONSTRAINT chain_transfer_events_addr_chk CHECK (
    token_address = LOWER(token_address) AND from_address = LOWER(from_address) AND to_address = LOWER(to_address))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- Where the log scanner got to. One row per (chain, stream) so a restart
-- resumes instead of rescanning from the beginning or skipping a gap.
CREATE TABLE chain_cursors (
  chain_id       INT         NOT NULL,
  stream         VARCHAR(64) NOT NULL,
  last_scanned_block BIGINT UNSIGNED NOT NULL,
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (chain_id, stream)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
