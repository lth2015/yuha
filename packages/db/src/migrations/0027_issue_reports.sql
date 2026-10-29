-- A private problem report about one song, from its owner (docs/ISSUE_REPORTS_SPEC.md).
--
-- `context` is what the server knew when the report was filed (job, provider
-- request, lyric timing source, the client's request id), so nobody has to
-- reconstruct it later. `audio_consent` is the owner's permission for staff
-- to listen to the song; without it there is no way to get the audio from a
-- report. Erased with the account (services/deletion.ts); kept when only the
-- song is deleted, by then without audio to hear.
CREATE TABLE issue_reports (
  id             CHAR(36) CHARACTER SET ascii NOT NULL,
  report_number  VARCHAR(16) CHARACTER SET ascii NOT NULL,
  user_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  kind           VARCHAR(24) NOT NULL,
  at_seconds     INT NULL,
  note           VARCHAR(500) NULL,
  audio_consent  TINYINT(1) NOT NULL DEFAULT 0,
  context        JSON NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'open',
  resolution     VARCHAR(500) NULL,
  resolved_by    CHAR(36) CHARACTER SET ascii NULL,
  resolved_at    DATETIME(3) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY issue_reports_number_uq (report_number),
  KEY issue_reports_status_idx (status, created_at),
  KEY issue_reports_track_idx (track_id, created_at),
  KEY issue_reports_user_idx (user_id),
  CONSTRAINT issue_reports_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT issue_reports_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT issue_reports_kind_chk CHECK (kind IN ('missing_vocals','lyrics_out_of_sync','audio_quality','download_failed','other')),
  CONSTRAINT issue_reports_status_chk CHECK (status IN ('open','resolved')),
  CONSTRAINT issue_reports_at_chk CHECK (at_seconds IS NULL OR at_seconds >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
