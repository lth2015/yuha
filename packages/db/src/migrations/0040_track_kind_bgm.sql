-- AI BGM (docs/BGM_STUDIO_PLAN.md): background music is a track like a song,
-- made by the same pipeline, told apart by `kind` and remembering the choices
-- it was made from (scenario, genre, mood, length, tempo feel; the creator's
-- note is not kept here — it is in the job's input like a song's prompt).
ALTER TABLE tracks
  ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'song',
  ADD COLUMN bgm JSON NULL,
  ADD CONSTRAINT tracks_kind_chk CHECK (kind IN ('song', 'bgm')),
  ADD KEY tracks_owner_kind_idx (owner_id, kind, created_at)
