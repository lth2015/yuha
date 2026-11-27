ALTER TABLE official_bgm
  ADD COLUMN master_format ENUM('mp3', 'wav') NOT NULL DEFAULT 'mp3' AFTER master_key,
  ADD COLUMN provenance JSON NULL AFTER state,
  ADD COLUMN cover_key VARCHAR(255) CHARACTER SET ascii NULL AFTER provenance;
