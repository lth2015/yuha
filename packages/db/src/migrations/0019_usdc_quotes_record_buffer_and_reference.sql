-- What a USDC quote was priced with, beyond the rate itself.
--
-- USDC is quoted from USD/JPY (one USDC priced as one US dollar) with a buffer
-- on top for the rate moving while the quote is open. The rate already has a
-- home (`rate_text`, `rate_provider`, `rate_source_at`, `rate_observed_at`);
-- two things did not:
--
--   rate_buffer_bps      the buffer actually applied, in basis points. It is
--                        configuration and will change, so the number that
--                        decided what this customer was asked to pay is
--                        stored with the quote, not looked up later.
--   rate_reference_text  the independent reference rate the primary was
--                        checked against. A quote is refused when the two
--                        disagree too far, so the reference is part of why
--                        this price was accepted, and belongs in the record.
--
-- Both NULL for JPYC, which consults no rate.
ALTER TABLE stablecoin_quotes
  ADD COLUMN rate_buffer_bps SMALLINT UNSIGNED NULL AFTER rate_observed_at,
  ADD COLUMN rate_reference_text VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER rate_buffer_bps,
  ADD CONSTRAINT stablecoin_quotes_buffer_chk CHECK (rate_buffer_bps IS NULL OR rate_buffer_bps <= 1000)
