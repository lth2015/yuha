-- Which wording a person was shown when they confirmed their age and accepted
-- the terms (docs/legal/COUNSEL_RESPONSE_2026-11.md, second round, 8): the
-- fact and the time were recorded, the wording was not. Set once, with the
-- first confirmation; NULL for confirmations made before it was recorded.
ALTER TABLE users
  ADD COLUMN consent_version VARCHAR(32) NULL AFTER terms_accepted_at
