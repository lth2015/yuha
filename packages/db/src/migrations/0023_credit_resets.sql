-- Credit resets: an operator, when they choose, tops every active account up
-- to a floor (5) counting everything it holds, and gives accounts that paid
-- since the previous reset a bonus (5) on top. Both expire at the next reset.
-- docs/CREDIT_RESET.md.
--
-- A source of its own, for the reason 0018 gave operator_gift one: "how much
-- did resets give away" must be a query, not a guess. The CHECK is rewritten
-- with the seventh value; packages/contracts/src/enums.ts carries the same
-- list and tests/operator-grant.test.ts holds them against each other.
ALTER TABLE entitlement_batches
  DROP CONSTRAINT entitlement_batches_source_chk
-- ;;
ALTER TABLE entitlement_batches
  ADD CONSTRAINT entitlement_batches_source_chk CHECK (source IN
    ('one_time_order','subscription_period','promo_trial','compensation',
     'manual_adjustment','operator_gift','credit_reset'))
-- ;;
-- One row per reset. It runs account by account and can be interrupted (a pod
-- roll); `cursor_user_id` is the last account finished, so running the same
-- reset again continues after it instead of starting over.
CREATE TABLE credit_resets (
  id               CHAR(36) CHARACTER SET ascii NOT NULL,
  idempotency_key  VARCHAR(128) NOT NULL,
  actor_id         CHAR(36) CHARACTER SET ascii NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  floor_units      INT NOT NULL,
  bonus_units      INT NOT NULL,
  -- Accounts that paid after this moment get the bonus: the previous reset,
  -- or 30 days back for the first one.
  window_start     DATETIME(3) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'running',
  cursor_user_id   CHAR(36) CHARACTER SET ascii NULL,
  users_seen       INT NOT NULL DEFAULT 0,
  users_topped     INT NOT NULL DEFAULT 0,
  units_topped     INT NOT NULL DEFAULT 0,
  users_bonus      INT NOT NULL DEFAULT 0,
  units_bonus      INT NOT NULL DEFAULT 0,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY credit_resets_idempotency_uk (idempotency_key),
  KEY credit_resets_created_idx (created_at),
  CONSTRAINT credit_resets_status_chk CHECK (status IN ('running','done'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
