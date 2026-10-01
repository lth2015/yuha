-- 0009 — an export belongs to one buyer, and the unique key did not say so.
--
-- `asset_versions_variant_uk` was (track_id, kind, params_hash). The stored
-- object's key, though, is `exportKey(userId, trackId, hash, format)` — it has
-- always been per user. So the row was shared where the object was not.
--
-- What that did to a second licence holder asking for the same clip of the
-- same song: `insertAsset`'s `ON DUPLICATE KEY UPDATE id = id` returned the
-- FIRST buyer's row, `createExport` answered with that `exportId`, and the
-- second buyer's own `POST /v1/exports/:id/download-url` then failed the
-- `a.owner_id = ?` check in `getAssetForUser`. The export appeared to succeed
-- and the paid download was unreachable — for every buyer after the first.
--
-- Adding the owner to the key only loosens it, so no existing row can
-- conflict. Masters are unaffected: a track has one owner, so (track_id,
-- kind, params_hash) and (track_id, owner_id, kind, params_hash) identify the
-- same single row for `kind = 'master'`.
--
-- Forward-fixed in a new file rather than by editing 0001, which is
-- checksum-tracked (§12.3).

-- The new key is added before the old one is dropped, not after.
-- `asset_versions_track_fk` needs an index whose leftmost column is
-- `track_id`, and the old unique key was the only one — dropping it first
-- fails with ER_DROP_INDEX_FK (1553). The new key also leads with `track_id`,
-- so once it exists the foreign key has its index and the old one is free.

ALTER TABLE asset_versions
  ADD UNIQUE KEY asset_versions_owner_variant_uk (track_id, owner_id, kind, params_hash)
-- ;;

ALTER TABLE asset_versions
  DROP INDEX asset_versions_variant_uk
