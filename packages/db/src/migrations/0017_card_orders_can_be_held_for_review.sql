-- A paid card order a person has to look at before it is delivered.
--
-- docs/FRAUD_PREVENTION.md's measure ⑥ was ticked for the stablecoin channel
-- and absent for the card one — the channel carrying every payment today. The
-- asymmetry was not an oversight so much as an artefact: on-chain payments
-- arrive with amounts and timings that do not match a quote, so a review queue
-- had to exist for them, while a card payment either succeeds or does not.
--
-- What a card payment can still be is somebody else's card. The remedy there
-- is not to refuse the payment — Stripe has already taken it and its own
-- screening has already had its say — but to hold DELIVERY while a person
-- looks, because what cannot be undone is the delivery. A chargeback takes the
-- money back; nothing takes back a song someone downloaded.
--
-- Deliberately narrow. The signals are our own data only, the thresholds are
-- configuration, and the default is that almost nothing is held: a hold on a
-- legitimate purchase is a customer who paid and received nothing, which is
-- its own kind of failure and a worse one at this scale.
CREATE TABLE order_reviews (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  order_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  -- Which signals fired, as an array of stable identifiers. Stored rather than
  -- recomputed: the thresholds are configuration and will move, and the reason
  -- an order was held in March has to still read as it did in March.
  reasons     JSON NOT NULL,
  amount_minor INT NOT NULL,
  currency    VARCHAR(3) CHARACTER SET ascii NOT NULL,
  held_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at  DATETIME(3) NULL,
  decided_by  CHAR(36) CHARACTER SET ascii NULL,
  -- 'release' hands over what was bought; 'refuse' leaves it undelivered and
  -- the refund is a person's next step in Stripe.
  decision    VARCHAR(16) CHARACTER SET ascii NULL,
  decision_reason TEXT NULL,
  PRIMARY KEY (id),
  -- One review per order: a replayed webhook must not open a second.
  UNIQUE KEY order_reviews_order_uk (order_id),
  KEY order_reviews_open_idx (decided_at, held_at),
  CONSTRAINT order_reviews_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT order_reviews_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT order_reviews_decision_chk CHECK (decision IS NULL OR decision IN ('release', 'refuse'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
