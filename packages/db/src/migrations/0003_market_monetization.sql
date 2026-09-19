-- 0003 — real lyric-alignment storage and Market monetization:
-- license purchases by other users, creator earnings ledger.

-- Word/line timing data for synced lyrics. Written by the worker after
-- delivery; NULL for instrumentals or when alignment failed. The JSON itself
-- carries the honesty label (source: aligned | estimated).
ALTER TABLE tracks
  ADD COLUMN lyric_timings JSON NULL
-- ;;

-- A bought license: the buyer may download and use one specific song under
-- the market terms in force at purchase time. One row per (buyer, song);
-- replays of the payment hit the unique order id instead.
CREATE TABLE track_licenses (
  id           CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  buyer_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  creator_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  order_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  price_paid   INT          NOT NULL,
  currency     VARCHAR(8)   NOT NULL DEFAULT 'usd',
  -- Share terms frozen at purchase time; a later rate change does not
  -- rewrite what this sale earned.
  creator_share_rate DECIMAL(5,4) NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY track_licenses_track_buyer_uk (track_id, buyer_id),
  UNIQUE KEY track_licenses_order_uk (order_id),
  KEY track_licenses_creator_idx (creator_id, created_at DESC),
  CONSTRAINT track_licenses_track_fk  FOREIGN KEY (track_id)  REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT track_licenses_buyer_fk  FOREIGN KEY (buyer_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT track_licenses_creator_fk FOREIGN KEY (creator_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT track_licenses_order_fk  FOREIGN KEY (order_id)  REFERENCES orders (id),
  CONSTRAINT track_licenses_price_chk CHECK (price_paid >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- Creator earnings: append-only accrual per license sale. `status` moves
-- pending → cleared → paid; payouts are operator actions until a payout
-- provider (e.g. Stripe Connect) is wired, and every movement is auditable.
CREATE TABLE creator_earnings (
  id           CHAR(36) CHARACTER SET ascii NOT NULL,
  creator_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  license_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  order_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  gross_minor  INT          NOT NULL,
  -- Creator portion in minor units (gross * share rate at sale time).
  amount_minor INT          NOT NULL,
  currency     VARCHAR(8)   NOT NULL DEFAULT 'usd',
  status       VARCHAR(16)  NOT NULL DEFAULT 'pending',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cleared_at   DATETIME(3)  NULL,
  paid_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY creator_earnings_license_uk (license_id),
  UNIQUE KEY creator_earnings_order_uk (order_id),
  KEY creator_earnings_creator_idx (creator_id, created_at DESC),
  CONSTRAINT creator_earnings_creator_fk FOREIGN KEY (creator_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT creator_earnings_track_fk   FOREIGN KEY (track_id)   REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT creator_earnings_license_fk FOREIGN KEY (license_id) REFERENCES track_licenses (id) ON DELETE CASCADE,
  CONSTRAINT creator_earnings_status_chk CHECK (status IN ('pending','cleared','paid')),
  CONSTRAINT creator_earnings_amount_chk CHECK (gross_minor >= 0 AND amount_minor >= 0 AND amount_minor <= gross_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;
