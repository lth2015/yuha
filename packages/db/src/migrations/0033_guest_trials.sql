-- Trying YUHA without an account (docs/GROWTH_SPEC.md, part three).
--
-- A guest is an ordinary users row with role 'guest', so generation, credits
-- and delivery need nothing new. Staff roles stay exactly as they were: the
-- console's role picker validates against its own list, which does not
-- include 'guest'.
ALTER TABLE users
  DROP CHECK users_role_chk,
  ADD CONSTRAINT users_role_chk CHECK (role IN ('user','support','admin','guest'))
-- ;;

-- One row per trial opened. What it keeps about the visitor is two keyed
-- hashes (HMAC-SHA256 under a server secret), never the address or the
-- browser's own identifier, and both are cleared when the trial is purged
-- after 7 days (docs/legal/PRIVACY_CHANGES_2026-11.md).
CREATE TABLE guest_trials (
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  device_ref  CHAR(64) CHARACTER SET ascii NULL,
  ip_ref      CHAR(64) CHARACTER SET ascii NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- The account it became part of, when the guest signed up in time.
  claimed_by  CHAR(36) CHARACTER SET ascii NULL,
  claimed_at  DATETIME(3) NULL,
  purged_at   DATETIME(3) NULL,
  PRIMARY KEY (user_id),
  KEY guest_trials_device_idx (device_ref),
  KEY guest_trials_ip_created_idx (ip_ref, created_at),
  KEY guest_trials_created_idx (created_at),
  CONSTRAINT guest_trials_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- Who waits for whom at the music engine: 0 for an account's song, 1 for a
-- trial's. A trial song is admitted only when no account's song is waiting.
ALTER TABLE generation_jobs
  ADD COLUMN priority TINYINT NOT NULL DEFAULT 0 AFTER state
