import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatTime, usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { Eq } from './Eq';

/**
 * One song card, used by Explore, the Library grid and the Home highlights.
 *
 * The play button plays through the shared queue (the feed the card came from
 * becomes the upcoming queue), and the heart optimistically toggles against
 */
export function SongCard({
  song,
  queue,
  index = 0,
  onRemove,
  disambiguator,
}: {
  song: TrackView;
  queue: TrackView[];
  /** Position in the grid, for the staggered entrance animation. */
  index?: number;
  /** Library-only: called after a successful delete. */
  onRemove?: (trackId: string) => void;
  /**
   * Set only when another song in the same list has this title. Sighted users
   * tell such cards apart by cover and position; a screen reader's list of
   * controls had nothing but two identical 「…を再生」 entries. Untitled songs
   * are auto-named, so this is not a corner case.
   */
  disambiguator?: string;
}) {
  const { t } = useI18n();
  const spoken = disambiguator ? `${song.title} ${disambiguator}` : song.title;
  const player = usePlayer();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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


  const setVisibility = async (visibility: 'public' | 'private') => {
    setBusy(true);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}/visibility`, { method: 'POST', body: { visibility } });
      song.visibility = visibility;
      setMenuOpen(false);
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
          aria-label={playing ? t('card.pause', { title: spoken }) : t('card.play', { title: spoken })}
        >
          <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
        </button>
        {song.state !== 'deliverable' && (
          <span className="song-card__badge">{song.state === 'processing' ? t('card.generating') : song.state}</span>
        )}
        {song.visibility === 'public' && <span className="song-card__public" >{t('card.onMarket')}</span>}
      </div>

      <div className="song-card__meta">
        {/* h2: the library's h1 is the only heading above the grid, and this
            was an h3 with no h2 between them (axe heading-order). The library
            is the card's only host. */}
        <h2 className="song-card__title" title={song.title}>
          <Link to={`/song/${song.trackId}`}>
            {song.title}
            {disambiguator && <span className="sr-only"> {disambiguator}</span>}
          </Link>
        </h2>
        <div className="song-card__sub">
          <span className="song-card__artist">
            {song.artistName ?? t(isMine ? 'card.you' : 'card.creator')}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatTime(song.durationSeconds)}</span>
          <span aria-hidden="true">·</span>
          <span className="song-card__mode">{t(song.vocalMode === 'instrumental' ? 'song.instrumental' : 'song.vocals')}</span>
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

        {(onRemove || song.state === 'deliverable') && (
          <div className="menu">
            <button
              type="button"
              className="menu__btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('card.more', { title: spoken })}
            >
              <span className="icon icon--dots" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="menu__panel" role="menu">
                <Link role="menuitem" to={`/song/${song.trackId}`} onClick={() => setMenuOpen(false)}>
                  {t('card.open')}
                </Link>
                <a
                  role="menuitem"
                  href={song.previewUrl ?? '#'}
                  download
                  aria-disabled={!song.previewUrl}
                  onClick={(e) => !song.previewUrl && e.preventDefault()}
                >
                  {t('card.download')}
                </a>
                {onRemove && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setVisibility(song.visibility === 'public' ? 'private' : 'public')}
                      disabled={busy}
                    >
                      {t(song.visibility === 'public' ? 'card.unpublish' : 'card.publish')}
                    </button>
                    <button type="button" role="menuitem" className="menu__danger" onClick={remove} disabled={busy}>
                      {t('card.delete')}
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
