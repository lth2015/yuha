-- 0004 — TOTP second factor (Google Authenticator compatible).
--
-- One factor row per user. The TOTP secret is AES-256-GCM encrypted by the
-- application (key material from env, never in the database); recovery codes
-- are stored only as SHA-256 hashes and consumed one at a time.

CREATE TABLE mfa_factors (
  id                CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  -- AES-256-GCM(payload) as produced by auth/totp.ts SecretBox.
  secret_encrypted  VARCHAR(255) NOT NULL,
  enabled           TINYINT(1)   NOT NULL DEFAULT 0,
  confirmed_at      DATETIME(3)  NULL,
  recovery_codes    JSON         NOT NULL,
  -- sha256 of challenge tokens already redeemed for a session; a challenge
  -- is single-use, enforced by the app before minting.
  spent_challenges  JSON         NOT NULL,
  last_used_at      DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY mfa_factors_user_uk (user_id),
  CONSTRAINT mfa_factors_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT mfa_factors_state_chk CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;
