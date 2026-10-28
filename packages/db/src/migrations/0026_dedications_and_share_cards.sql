-- A song written for somebody, and the picture its link shows when shared.
-- docs/GIFT_AND_SHARE_SPEC.md.
--
-- `dedication` is {to, occasion, note?, lang}: who the song is for, shown at
-- the top of its page and in its link preview. NULL for every song written
-- for nobody in particular, which is every song before this migration.
ALTER TABLE tracks
  ADD COLUMN dedication JSON NULL
-- ;;
-- The link-preview image a song's owner uploaded (drawn in their browser,
-- which has the sleeve and the fonts; the server has neither). One per song,
-- replaced in place. Served only while the song is public.
--
-- Its own table rather than an asset_versions kind: those rows are audio, with
-- CHECKs on format and duration and readers that list them as downloads. The
-- account-deletion sweep removes these objects too (services/deletion.ts).
CREATE TABLE share_cards (
  track_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  owner_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  storage_key  VARCHAR(512) NOT NULL,
  byte_size    INT NOT NULL,
  sha256       CHAR(64) CHARACTER SET ascii NOT NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (track_id),
  KEY share_cards_owner_idx (owner_id),
  CONSTRAINT share_cards_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT share_cards_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT share_cards_size_chk CHECK (byte_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
