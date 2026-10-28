-- Lyric re-alignment: an admin re-runs the aligner over songs made before it
-- improved, so their synced lyrics follow the voice. docs/LYRIC_ALIGNMENT.md.
--
-- One row per run. It goes song by song and can be interrupted (a pod roll);
-- `cursor_track_id` is the last song finished, so running the same run again
-- continues after it. A song whose timing a person corrected is never touched,
-- and a song the aligner could not hear better keeps what it had.
CREATE TABLE lyric_realignments (
  id               CHAR(36) CHARACTER SET ascii NOT NULL,
  idempotency_key  VARCHAR(128) NOT NULL,
  actor_id         CHAR(36) CHARACTER SET ascii NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'running',
  cursor_track_id  CHAR(36) CHARACTER SET ascii NULL,
  tracks_seen      INT NOT NULL DEFAULT 0,
  tracks_realigned INT NOT NULL DEFAULT 0,
  tracks_kept      INT NOT NULL DEFAULT 0,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY lyric_realignments_idempotency_uk (idempotency_key),
  KEY lyric_realignments_created_idx (created_at),
  CONSTRAINT lyric_realignments_status_chk CHECK (status IN ('running','done'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
