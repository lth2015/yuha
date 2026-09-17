-- 0002 — SONARE product scope: full songs (vocals, lyrics, chosen length),
-- the public Explore feed, likes, play counters and Google identity codes.
--
-- The 2026-09-18 pivot supersedes the "30s instrumental only" launch scope;
-- every guarantee the ledger and job machinery provide is untouched.

ALTER TABLE tracks
  ADD COLUMN styles        JSON         NULL,
  ADD COLUMN lyrics        MEDIUMTEXT   NULL,
  ADD COLUMN vocal_mode    VARCHAR(16)  NOT NULL DEFAULT 'instrumental',
  ADD COLUMN visibility    VARCHAR(16)  NOT NULL DEFAULT 'private',
  ADD COLUMN play_count    INT          NOT NULL DEFAULT 0,
  ADD COLUMN like_count    INT          NOT NULL DEFAULT 0,
  ADD COLUMN cover_seed    INT          NOT NULL DEFAULT 0,
  ADD KEY tracks_public_idx (visibility, state, created_at DESC),
  ADD CONSTRAINT tracks_vocal_mode_chk CHECK (vocal_mode IN ('instrumental','with_vocals')),
  ADD CONSTRAINT tracks_visibility_chk CHECK (visibility IN ('private','public')),
  ADD CONSTRAINT tracks_counts_chk CHECK (play_count >= 0 AND like_count >= 0)
-- ;;

-- Explore feed likes. One row per (user, song); the counter on tracks is the
-- derived cache, maintained in the same transaction.
CREATE TABLE song_likes (
  id         CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY song_likes_user_track_uk (user_id, track_id),
  KEY song_likes_track_idx (track_id, created_at DESC),
  CONSTRAINT song_likes_user_fk  FOREIGN KEY (user_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT song_likes_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- One-time codes issued at the end of the Google OAuth redirect, exchanged for
-- a session token by the SPA. Hashed at rest so a leaked row is not a session.
CREATE TABLE auth_codes (
  id         CHAR(36) CHARACTER SET ascii NOT NULL,
  code_hash  CHAR(64) CHARACTER SET ascii NOT NULL,
  user_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY auth_codes_hash_uk (code_hash),
  KEY auth_codes_expiry_idx (expires_at),
  CONSTRAINT auth_codes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT auth_codes_used_chk CHECK (used_at IS NULL OR used_at <= expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- Google profile data for accounts created via "Sign in with Google".
ALTER TABLE users
  ADD COLUMN avatar_url VARCHAR(512) NULL
-- ;;
