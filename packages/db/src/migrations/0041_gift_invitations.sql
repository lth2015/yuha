-- Music Gift Invitation (docs/GIFT_INVITATION_PLAN.md, PRD V1.1).
--
-- A link of its own for one song: /gift/{token}. The token is 32 random bytes
-- shown to the owner once; only its SHA-256 is kept, so this table cannot be
-- read back into working links. One song may have many invitations, each
-- revoked on its own; the song need not be public.
--
-- What the recipient sees is written here for them (recipient_name,
-- sender_name, message) and screened at write time like a dedication. When
-- the song or the account goes, the words are cleared and the row revoked;
-- the row itself goes with the track (ON DELETE CASCADE).
CREATE TABLE gift_invitations (
  id              CHAR(36) CHARACTER SET ascii NOT NULL,
  track_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  owner_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  recipient_name  VARCHAR(30) NULL,
  sender_name     VARCHAR(30) NULL,
  message         VARCHAR(300) NULL,
  theme           VARCHAR(16) NOT NULL,
  token_hash      CHAR(64) CHARACTER SET ascii NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3) NULL,
  revoked_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY gift_invitations_token_uk (token_hash),
  KEY gift_invitations_track_idx (track_id, created_at),
  KEY gift_invitations_owner_idx (owner_id),
  CONSTRAINT gift_invitations_track_fk FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT gift_invitations_status_chk CHECK (status IN ('active','revoked')),
  CONSTRAINT gift_invitations_theme_chk CHECK (theme IN ('warm','romantic','celebration'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
