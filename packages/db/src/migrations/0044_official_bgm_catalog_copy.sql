-- The official BGM catalogue, described (product owner, 2026-11-27): a title
-- and an introduction in zh/ja/en, style tags, and a YUHA recommendation
-- score out of five.
--
-- `copy` holds what an editor wrote, per language ({"zh":{"title","intro"},…});
-- a language left out falls back to the original title and a template intro
-- built from the track's genre, mood and use (apps/web). `tags` are free
-- style words shown as chips. `rating` is an editorial score, shown as
-- "YUHA 推荐指数" and never as a user rating: there are no user ratings. Until
-- a recommendation standard exists, a track starts at a random 3.8–4.5
-- (product owner's decision); an editor can set it by hand.
ALTER TABLE official_bgm
  ADD COLUMN copy JSON NULL AFTER mood,
  ADD COLUMN tags JSON NULL AFTER copy,
  ADD COLUMN rating DECIMAL(2,1) NULL AFTER tags,
  ADD CONSTRAINT official_bgm_rating_chk CHECK (rating IS NULL OR rating BETWEEN 1.0 AND 5.0)
-- ;;

UPDATE official_bgm SET rating = ROUND(3.8 + RAND() * 0.7, 1) WHERE rating IS NULL
