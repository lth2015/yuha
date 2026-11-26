-- "Align it again", for one song, by its owner (docs/LYRIC_ALIGNMENT.md,
-- "Aligning one song again"; docs/MV_LYRIC_SYNC_UX_SPEC.md, phase 2).
--
-- One row per request. The aligner is asked with the song's own audio and its
-- answer is kept here as a proposal: the owner listens to it in the timing
-- workspace and saves it or not. Nothing in this table ever changes a song's
-- saved timing.
--
-- `lyrics_sha` is the lyrics the request was made for: an answer for words the
-- song no longer has is not offered. The proposal holds lines of the lyrics,
-- so it goes with the song: ON DELETE CASCADE, and the deletion paths that
-- clear a song's words clear its proposals too (services/deletion.ts,
-- services/guest-trial.ts).
CREATE TABLE lyric_proposals (
  id          CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  owner_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'queued',
  lyrics_sha  CHAR(64) CHARACTER SET ascii NOT NULL,
  timings     JSON NULL,
  failure     VARCHAR(64) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at  DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY lyric_proposals_track_idx (track_id, created_at),
  KEY lyric_proposals_queue_idx (status, created_at),
  CONSTRAINT lyric_proposals_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT lyric_proposals_status_chk CHECK (status IN ('queued','running','ready','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
