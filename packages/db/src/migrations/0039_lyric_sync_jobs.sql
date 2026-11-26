-- Automatic lyric sync (docs/AUTOMATIC_LYRIC_SYNC_TICKETS.md, L4a).
--
-- One row per (song, delivered audio, lyrics): the unique key is what makes a
-- refresh, a second tab or a retried delivery one job and not three. The
-- worker claims a due row, asks the aligner, and applies a result that passes
-- through the guarded write (tracks.ts storeDeliveredLyricTimings): never over
-- a person's correction, never onto other audio or other words, never an
-- estimate over a heard timeline. Status:
--   queued   waiting, or waiting to be retried at next_attempt_at
--   running  claimed by claimed_by at claimed_at (taken back when stale)
--   applied  the aligner heard the song and its timeline is the song's now
--   kept     a result came back but the song had changed or was corrected
--   failed   attempts used up; a labelled estimate was kept instead
-- The rows hold no words, only hashes; ON DELETE CASCADE, as the song goes.
CREATE TABLE lyric_sync_jobs (
  id              CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  master_sha256   CHAR(64) CHARACTER SET ascii NOT NULL,
  lyrics_sha      CHAR(64) CHARACTER SET ascii NOT NULL,
  trigger_kind    VARCHAR(16) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_by      VARCHAR(64) NULL,
  claimed_at      DATETIME(3) NULL,
  failure         VARCHAR(64) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at     DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY lyric_sync_jobs_version_uk (track_id, master_sha256, lyrics_sha),
  KEY lyric_sync_jobs_due_idx (status, next_attempt_at),
  CONSTRAINT lyric_sync_jobs_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT lyric_sync_jobs_status_chk CHECK (status IN ('queued','running','applied','kept','failed')),
  CONSTRAINT lyric_sync_jobs_trigger_chk CHECK (trigger_kind IN ('delivery','backfill','retry'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
