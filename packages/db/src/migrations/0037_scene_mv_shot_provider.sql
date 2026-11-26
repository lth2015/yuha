-- Which video service made each scene MV shot (docs/AI_SCENE_MV_VEO_SPEC.md §4).
--
-- A clip id means something only to the service that issued it. With the
-- self-hosted LTX service and Veo through TokenStars both in play, a shot
-- submitted to one is never asked about at the other: the worker fails it as
-- `provider_changed` instead of submitting it again somewhere new.
ALTER TABLE scene_mv_shots
  ADD COLUMN provider VARCHAR(32) CHARACTER SET ascii NULL AFTER provider_clip_id
