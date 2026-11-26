-- What the AI scene MV may have cost (docs/AI_SCENE_MV_VEO_SPEC.md §3).
--
-- One row per shot attempt that was, or may have been, paid for at the video
-- service, reserved before the request goes out and checked against the daily
-- and total budgets under one lock. `refunded` marks what is known not to
-- cost anything: never sent, or failed at the service (TokenStars refunds a
-- failed task). An uncertain submit, a timeout or a clip YUHA fetched and then
-- refused stays counted.
--
-- No foreign key to scene_mvs on purpose: the cost of an MV outlives the MV,
-- for reconciling against the provider's bill. The rows hold ids and amounts,
-- nothing anyone wrote.
CREATE TABLE scene_mv_charges (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  scene_mv_id CHAR(36) CHARACTER SET ascii NOT NULL,
  shot_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  owner_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  attempt     TINYINT UNSIGNED NOT NULL,
  micros      BIGINT UNSIGNED NOT NULL,
  refunded    TINYINT(1) NOT NULL DEFAULT 0,
  day_jst     DATE NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY scene_mv_charges_day_idx (day_jst, refunded),
  KEY scene_mv_charges_shot_idx (shot_id, attempt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
