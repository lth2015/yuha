-- Where an account has signed in from before, so a sign-in from somewhere new
-- can be told apart from the fiftieth from the same desk. Without this, a
-- notice on every sign-in would be noise, and noise is how a real warning gets
-- missed.
--
-- The address itself is NOT stored. `source_hash` is an HMAC of the client
-- address and user agent under a server secret, which answers "have we seen
-- this before" and nothing else: it cannot be reversed into an address, and it
-- is useless to anyone who reads the table without the key. The email names
-- the address, because it goes to the one person entitled to know it.
CREATE TABLE known_sign_in_sources (
  user_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  -- HMAC-SHA256, hex.
  source_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  first_seen  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, source_hash),
  KEY known_sign_in_sources_last_seen_idx (last_seen),
  CONSTRAINT known_sign_in_sources_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
