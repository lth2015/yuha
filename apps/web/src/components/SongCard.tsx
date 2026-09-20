import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { Eq } from './Eq';

/**
 * One song card, used by Explore, the Library grid and the Home highlights.
 *
 * The play button plays through the shared queue (the feed the card came from
 * becomes the upcoming queue), and the heart optimistically toggles against
 * POST /v1/explore/:id/like.
 */
export function SongCard({
  song,
  queue,
  index = 0,
  onRemove,
}: {
  song: TrackView;
  queue: TrackView[];
  /** Position in the grid, for the staggered entrance animation. */
  index?: number;
  /** Library-only: called after a successful delete. */
  onRemove?: (trackId: string) => void;
}) {
  const player = usePlayer();
  const [liked, setLiked] = useState<boolean>(song.likedByMe ?? false);
  const [likeCount, setLikeCount] = useState(song.likeCount);
  const [busy, setBusy] = useState(false);
  const [menu打开, setMenu打开] = useState(false);

  const isMine = song.artistId === '' ? false : !!song.artistId; // set by parent context if known
  const active = player.activeId === song.trackId;
  const playing = active && player.status === 'playing';

  const reportPlay = useCallback(() => {
    void apiFetch(`/v1/explore/${song.trackId}/plays`, { method: 'POST' }).catch(() => undefined);
  }, [song.trackId]);

  const onPlay = () => {
    if (!song.previewUrl) return;
    if (!active) reportPlay();
    player.play(
      { ...song, previewUrl: song.previewUrl },
      queue.filter((s) => s.previewUrl).map((s) => ({ ...s, previewUrl: s.previewUrl })),
    );
  };

  const toggleLike = async () => {
    if (busy || liked === null) return;
    setBusy(true);
    const action = liked ? 'unlike' : 'like';
    // Optimistic; the server count is authoritative on response.
    setLiked(!liked);
    try {
      const res = await apiFetch<{ liked: boolean; likeCount: number }>(`/v1/explore/${song.trackId}/like`, {
        method: 'POST',
        body: { action },
      });
      setLiked(res.liked);
      setLikeCount(res.likeCount);
    } catch {
      setLiked(liked); // roll back
    } finally {
      setBusy(false);
    }
  };

  const setVisibility = async (visibility: 'public' | 'private') => {
    setBusy(true);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}/visibility`, { method: 'POST', body: { visibility } });
      song.visibility = visibility;
      setMenu打开(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除 “${song.title}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}`, { method: 'DELETE' });
      onRemove?.(song.trackId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="song-card"
      data-active={active || undefined}
      style={{ '--i': index } as React.CSSProperties}
    >
      <div className="song-card__art">
        <CoverArt seed={song.coverSeed} title={song.title} size={300} playing={playing} />
        {active && <Eq live={playing} className="song-card__eq" />}
        <button
          type="button"
          className="song-card__play"
          onClick={onPlay}
          disabled={!song.previewUrl}
          aria-label={playing ? `暂停「${song.title}」` : `播放「${song.title}」`}
        >
          <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
        </button>
        {song.state !== 'deliverable' && (
          <span className="song-card__badge">{song.state === 'processing' ? '生成中…' : song.state}</span>
        )}
        {song.visibility === 'public' && <span className="song-card__public" title="Published to Explore">市场在架</span>}
      </div>

      <div className="song-card__meta">
        <h3 className="song-card__title" title={song.title}>
          <Link to={`/song/${song.trackId}`}>{song.title}</Link>
        </h3>
        <div className="song-card__sub">
          <span className="song-card__artist">
            {song.artistName ?? (isMine ? '你' : '创作者')}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatTime(song.durationSeconds)}</span>
          <span aria-hidden="true">·</span>
          <span className="song-card__mode">{song.vocalMode === 'instrumental' ? '纯音乐' : '有人声'}</span>
        </div>
        {song.styles.length > 0 && (
          <div className="song-card__styles">
            {song.styles.slice(0, 3).map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="song-card__actions">
        <button
          type="button"
          className={`like-btn${liked ? ' like-btn--on' : ''}`}
          onClick={toggleLike}
          disabled={busy || liked === null}
          aria-pressed={liked ?? undefined}
          aria-label={liked ? `取消喜欢「${song.title}」` : `喜欢「${song.title}」`}
        >
          <span className="icon icon--heart" aria-hidden="true" />
          <span className="like-btn__count">{likeCount}</span>
        </button>

        {(onRemove || song.state === 'deliverable') && (
          <div className="menu">
            <button
              type="button"
              className="menu__btn"
              onClick={() => setMenu打开((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menu打开}
              aria-label={`「${song.title}」的更多操作`}
            >
              <span className="icon icon--dots" aria-hidden="true" />
            </button>
            {menu打开 && (
              <div className="menu__panel" role="menu">
                <Link role="menuitem" to={`/song/${song.trackId}`} onClick={() => setMenu打开(false)}>
                  打开
                </Link>
                <a
                  role="menuitem"
                  href={song.previewUrl ?? '#'}
                  download
                  aria-disabled={!song.previewUrl}
                  onClick={(e) => !song.previewUrl && e.preventDefault()}
                >
                  下载 MP3
                </a>
                {onRemove && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setVisibility(song.visibility === 'public' ? 'private' : 'public')}
                      disabled={busy}
                    >
                      {song.visibility === 'public' ? '取消发布' : '发布到市场'}
                    </button>
                    <button type="button" role="menuitem" className="menu__danger" onClick={remove} disabled={busy}>
                      删除
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
