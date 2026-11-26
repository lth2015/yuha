-- AI scene MVs (docs/AI_SCENE_MV_SPEC.md; tickets T4 in docs/AI_SCENE_MV_TICKETS.md).
--
-- One row per MV a song's owner asks for, and one row per shot of it. A job
-- moves draft → queued → generating → composing → ready, or ends failed or
-- cancelled; packages/db/src/scene-mvs.ts is the only writer and allows only
-- those moves.
--
-- `active_owner` is the owner while the job is in the queue or being made and
-- NULL otherwise, under a unique key: one person has one job in the GPU's
-- queue at a time, and two requests cannot race past that, because the
-- database refuses the second. Drafts are free and do not count. The same
-- pattern as users.email_active in 0001.
--
-- `description` and the shots' `prompt` are what the person wrote about the
-- picture. They are never logged; they go with the song (ON DELETE CASCADE)
-- and with the job when it expires (`expires_at`, swept by the pipeline).
CREATE TABLE scene_mvs (
  id           CHAR(36) CHARACTER SET ascii NOT NULL,
  owner_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'draft',
  style        VARCHAR(32) NOT NULL,
  description  TEXT NULL,
  clip_start   DECIMAL(7,2) NOT NULL,
  clip_end     DECIMAL(7,2) NOT NULL,
  -- The lyric timing the subtitles were cut from, so a later edit is not silently mixed in.
  timings_sha  CHAR(64) CHARACTER SET ascii NULL,
  output_key   VARCHAR(255) NULL,
  failure      VARCHAR(64) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  queued_at    DATETIME(3) NULL,
  finished_at  DATETIME(3) NULL,
  expires_at   DATETIME(3) NULL,
  active_owner CHAR(36) CHARACTER SET ascii GENERATED ALWAYS AS
                 (CASE WHEN status IN ('queued','generating','composing') THEN owner_id END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY scene_mvs_one_active_uk (active_owner),
  KEY scene_mvs_owner_idx (owner_id, created_at),
  KEY scene_mvs_track_idx (track_id),
  KEY scene_mvs_queue_idx (status, queued_at),
  CONSTRAINT scene_mvs_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT scene_mvs_status_chk CHECK (status IN ('draft','queued','generating','composing','ready','failed','cancelled')),
  CONSTRAINT scene_mvs_span_chk CHECK (clip_end > clip_start AND clip_start >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- ;;
CREATE TABLE scene_mv_shots (
  id               CHAR(36) CHARACTER SET ascii NOT NULL,
  scene_mv_id      CHAR(36) CHARACTER SET ascii NOT NULL,
  idx              TINYINT UNSIGNED NOT NULL,
  prompt           TEXT NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  provider_clip_id VARCHAR(64) CHARACTER SET ascii NULL,
  clip_key         VARCHAR(255) NULL,
  failure          VARCHAR(64) NULL,
  claimed_by       VARCHAR(64) NULL,
  started_at       DATETIME(3) NULL,
  finished_at      DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY scene_mv_shots_order_uk (scene_mv_id, idx),
  KEY scene_mv_shots_status_idx (status),
  CONSTRAINT scene_mv_shots_mv_fk FOREIGN KEY (scene_mv_id) REFERENCES scene_mvs (id) ON DELETE CASCADE,
  CONSTRAINT scene_mv_shots_status_chk CHECK (status IN ('pending','running','succeeded','failed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
