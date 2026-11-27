-- Sale rights, reviewed per track (docs/PAYMENTS_DESIGN.md §1, product owner
-- 2026-11-27). Publishing a track opens it for listening; selling a licence
-- for it is a separate decision, made one track at a time with a recorded
-- basis. Import and "publish all" never touch these columns: a batch that
-- says `license_status: cleared` still needs this review before anyone can
-- buy.
ALTER TABLE official_bgm
  ADD COLUMN sale_rights VARCHAR(12) NOT NULL DEFAULT 'unreviewed' AFTER rating,
  ADD COLUMN sale_rights_basis VARCHAR(500) NULL AFTER sale_rights,
  ADD COLUMN sale_rights_by CHAR(36) CHARACTER SET ascii NULL AFTER sale_rights_basis,
  ADD COLUMN sale_rights_at DATETIME(3) NULL AFTER sale_rights_by,
  ADD CONSTRAINT official_bgm_sale_rights_chk CHECK (sale_rights IN ('unreviewed','cleared','refused')),
  ADD CONSTRAINT official_bgm_sale_basis_chk CHECK (sale_rights = 'unreviewed' OR sale_rights_basis IS NOT NULL)
