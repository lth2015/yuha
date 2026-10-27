-- Lyrics written ahead of generation (Air composition → /create). No credit
-- pays for them, so each account may ask a set number of times in 24 hours
-- (LYRIC_DRAFTS_PER_DAY). This table exists only to count: it holds no
-- prompt and no lyrics. The cost of each call is in provider_cost_events.
CREATE TABLE lyric_drafts (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  -- pending while the text model is writing; then ok, refused or failed.
  status      VARCHAR(16) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY lyric_drafts_user_time_idx (user_id, created_at),
  CONSTRAINT lyric_drafts_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
