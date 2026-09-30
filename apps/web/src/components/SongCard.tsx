import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatTime, usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { CoverArt } from './CoverArt';
import { Eq } from './Eq';

/**
 * One song card, used by the showcase, the Library grid and the create page's
 * recent strip.
 *
 * The play button plays through the shared queue: the list the card came from
 * becomes the upcoming queue.
 *
 * The card is rendered to three different readers — the owner, a signed-in
 * stranger, and, since the showcase went back on the landing page, somebody
 * with no account at all — so what it offers is decided from the song and the
 * session rather than assumed. Playing is for everyone; the account menu is
 * for someone who has an account; downloading the master is for whoever owns
 * the song or has bought a licence for it.
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

  const { me } = useSession();
  /*
   * This read `song.artistId === '' ? false : !!song.artistId`, with a comment
   * saying the parent set it "if known". No parent ever did, and `artistId` is
   * a uuid on every view, so it was `true` for every card ever rendered —
   * including other people's songs, where it would have labelled the artist
   * 「你」 the moment `artistName` came back null. It never bit because the
   * seeded artists all have display names. Ask the session instead.
   */
  const isMine = !!me && song.artistId === me.userId;
  /*
   * The same rule `Layout` applies to the Now Playing download: the master is
   * for the person who made the song or the person who licensed it. The card
   * used to offer it to anyone holding the card, which was invisible while
   * every list was the owner's own — and became a free download of a
   * full-quality master, to a reader with no account, the moment the showcase
   * appeared on the landing page.
   */
  const canDownload = isMine || song.licensedByMe === true;
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
        <CoverArt seed={song.coverSeed} title={song.title} styles={song.styles} size={300} playing={playing} />
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
        {/* "Your link is on" is something to tell an owner; on the showcase
            every card is public, so it would be noise on all of them. */}
        {isMine && song.visibility === 'public' && (
          <span className="song-card__public">{t('card.onMarket')}</span>
        )}
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

        {me && (onRemove || song.state === 'deliverable') && (
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
                {canDownload && (
                  <a
                    role="menuitem"
                    href={song.previewUrl ?? '#'}
                    download
                    aria-disabled={!song.previewUrl}
                    onClick={(e) => !song.previewUrl && e.preventDefault()}
                  >
                    {t('card.download')}
                  </a>
                )}
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
