-- 0007 — account deletion as a record that can be worked, not an analytics row.
--
-- SEC-11 has been half-built since it was written: POST /v1/me/deletion-request
-- answers with a ticket and a statement of what is kept and what goes, and the
-- only trace it leaves is one `analytics_events` row. That table is an
-- append-only measurement log — nothing can move a request through states, and
-- an operator cannot even list what is waiting. The promise was recorded; the
-- work was not.
--
-- The flow this table supports is the one the endpoint already describes to the
-- user: a request is received, a human verifies the identity behind it, and
-- only then is anything erased. Verification stays a human act on purpose —
-- "delete my account" arriving on a stolen session must not be self-executing.

CREATE TABLE account_deletions (
  id            CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  -- What the user was told to quote. Returned by the request endpoint, so it
  -- is the handle support will be given over the phone.
  ticket        CHAR(36) CHARACTER SET ascii NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'requested',
  -- Free text the user gave for leaving. Never required, and never a condition
  -- of honouring the request.
  reason        VARCHAR(1000) NULL,
  requested_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Who confirmed the person asking is the account holder, and when.
  verified_by   CHAR(36) CHARACTER SET ascii NULL,
  verified_at   DATETIME(3)  NULL,
  executed_at   DATETIME(3)  NULL,
  -- What erasure actually did: counts per kind, and anything it refused to
  -- touch. Written once, as evidence; the response to the user is prose, and
  -- prose is not an audit trail.
  outcome       JSON         NULL,
  -- Why a run stopped, when one did. Kept so a failure is visible in the list
  -- rather than only in a log line nobody reads.
  failure       VARCHAR(500) NULL,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- One OPEN request per account: a second "delete me" must find the first
  -- rather than open a race between two erasures of the same data. MySQL has
  -- no partial indexes, so this is the same generated-column trick
  -- `users.email_active` uses — NULL for closed rows, and a unique index
  -- ignores NULLs.
  --
  -- A plain UNIQUE (user_id, status) was the first attempt and is a trap: it
  -- also forbids a second `failed` row, so a user whose first erasure failed
  -- could never have another request fail, and the insert would blow up on a
  -- constraint that was never meant to say anything about closed requests.
  open_user_id  CHAR(36) CHARACTER SET ascii GENERATED ALWAYS AS
                  (CASE WHEN status IN ('requested','verified') THEN user_id END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY account_deletions_ticket_uk (ticket),
  UNIQUE KEY account_deletions_open_uk (open_user_id),
  KEY account_deletions_status_idx (status, requested_at),
  CONSTRAINT account_deletions_user_fk     FOREIGN KEY (user_id)     REFERENCES users (id),
  CONSTRAINT account_deletions_verifier_fk FOREIGN KEY (verified_by) REFERENCES users (id),
  CONSTRAINT account_deletions_status_chk CHECK (status IN
    ('requested','verified','executed','failed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
