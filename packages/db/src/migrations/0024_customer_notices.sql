-- Customer notices that must go out once and only once: a refund, a
-- subscription set to end, a subscription ended. Stripe delivers webhook
-- events at least once and sends overlapping events for the same money
-- (`charge.refunded` and `refund.created`), so the claim on (kind, ref) is
-- what keeps a customer from receiving the same email twice. Holds no text:
-- only that a notice of this kind, for this thing, was sent.
CREATE TABLE customer_notices (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  kind        VARCHAR(32) NOT NULL,
  ref         VARCHAR(191) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY customer_notices_kind_ref_uk (kind, ref),
  KEY customer_notices_user_idx (user_id),
  CONSTRAINT customer_notices_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
