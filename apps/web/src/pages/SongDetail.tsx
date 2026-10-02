import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { LyricTimings, ProductView, TrackView } from '@yuha/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { fetchProducts, findLicenceProduct } from '../lib/catalog';
import { useI18n } from '../lib/i18n';
import { LOCALES, formatMoney } from '../lib/money';
import { useSession } from '../lib/session';
import { CoverArt } from '../components/CoverArt';
import { ErrorNotice } from '../components/common';
import { Score } from '../components/Score';
import { ShareMenu } from '../components/ShareMenu';
import { SyncedLyrics } from '../components/SyncedLyrics';
import { scoreFromSeed } from '../lib/score';
import { usePageTitle } from '../lib/title';

interface SongDetailResponse extends TrackView {
  lyrics: string | null;
  exports?: Array<{
    exportId: string;
    format: string;
    clipStartSeconds: number;
    clipDurationSeconds: number;
    fadeOut: boolean;
    byteSize: number;
    createdAt: string;
  }>;
}

/**
 * The song page as an editorial spread: the cover is the art object, the
 * title gets display scale, meta reads as small caps, actions are quiet text
 * controls — gallery, not form.
 */
export default function SongDetail() {
  const { t, lang } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { me, runtime } = useSession();
  const player = usePlayer();
  const [song, setSong] = useState<SongDetailResponse | null>(null);
  // A song page is best titled by its song, not by the word "song".
  usePageTitle(song?.title);
  const [error, setError] = useState<unknown>(null);
  /*
   * Kept apart from `error` on purpose. `error` is the page failing to
   * load and replaces the page; this one belongs beside the buttons, so a
   * failed download or licence purchase does not take the song with it.
   */
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [licenseProduct, setLicenseProduct] = useState<ProductView | null>(null);
  const [licensing, setLicensing] = useState(false);
  // `player.currentTime` re-renders this several times a second while the song
  // plays; the score itself only depends on the seed.
  const songScore = useMemo(() => (song ? scoreFromSeed(song.coverSeed, 72) : null), [song?.coverSeed]);

  /*
   * One load per id, and a slow one never wins.
   *
   * This used to be a bare `.then(setSong).catch(setError)` with no
   * cancellation and no reset: clicking song A then quickly song B let A's
   * slower response paint A's title, cover and lyrics under B's URL. And
   * because `error` was never cleared, one failed song latched the error
   * screen over every song opened afterwards, for the rest of the session.
   */
  const load = useCallback(() => {
    if (!id) return undefined;
    let cancelled = false;
    setError(null);
    apiFetch<SongDetailResponse>(`/v1/tracks/${id}`)
      .then((s) => {
        if (!cancelled) setSong(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    // Not `.catch(() => undefined)`. That swallowed a shape mismatch for eight
    // days, leaving the licence button permanently disabled with its price
    // interpolated to an empty string and nothing written anywhere.
    fetchProducts()
      .then((ps) => setLicenseProduct(findLicenceProduct(ps)))
      .catch((err) => {
        console.error('the catalogue could not be read; licensing is unavailable', err);
        setLicenseProduct(null);
      });
  }, []);

  /*
   * `error` is the LOAD failing, which is the only failure that should
   * replace the page. Download and licence failures used to write the same
   * state, so one flaky request made the cover, title, lyrics, player and
   * every action vanish — replaced by a full-page error whose only way out
   * was "back to library", with no retry and nothing re-run. On the buy path.
   */
  if (error) {
    return (
      <div className="stack">
        <ErrorNotice error={error} />
        <Link to={me ? '/library' : '/'} className="btn">
          {t(me ? 'song.backMarket' : 'song.backHome')}
        </Link>
      </div>
    );
  }
  if (!song) {
    return <div className="skeleton skeleton--detail" aria-hidden="true" />;
  }

  const isOwner = me?.userId === song.artistId;
  const active = player.activeId === song.trackId;
  const playing = active && player.status === 'playing';

  const play = () => {
    if (!song.previewUrl) return;
    if (!active) {
      void apiFetch(`/v1/explore/${song.trackId}/plays`, { method: 'POST' }).catch(() => undefined);
    }
    /*
     * A queue of exactly this song. Without one the player kept whatever list
     * was loaded last, while the active id was a track that is not in it: Next
     * jumped to the FIRST song of that stale list and Prev did nothing, both
     * with their buttons enabled.
     */
    const here = [{ ...song, previewUrl: song.previewUrl }];
    player.play({ ...song, previewUrl: song.previewUrl }, here);
  };


  const setVisibility = async (visibility: 'public' | 'private') => {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}/visibility`, { method: 'POST', body: { visibility } });
      setSong({ ...song, visibility });
    } catch (err) {
      // There was no catch: offline, the menu kept the old label and said
      // nothing, so publishing appeared to work and had not.
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('song.confirmDelete', { title: song.title }))) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}`, { method: 'DELETE' });
      navigate('/library');
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ downloadUrl: string }>(`/v1/tracks/${song.trackId}/exports`, {
        method: 'POST',
        body: { clipStartSeconds: 0, clipDurationSeconds: Math.round(song.durationSeconds), fadeOut: false },
      });
      window.location.href = res.downloadUrl;
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const buyLicense = async () => {
    if (licensing || !me) return;
    setLicensing(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ orderId: string; checkoutUrl: string; simulated: boolean }>(
        `/v1/market/tracks/${song.trackId}/license`,
        { method: 'POST', idempotencyKey: newIdempotencyKey('license') },
      );
      if (res.simulated) {
        window.location.href = `/checkout/simulate?session_id=${new URL(res.checkoutUrl).searchParams.get('session_id')}&order_id=${res.orderId}`;
      } else {
        window.location.href = res.checkoutUrl;
      }
    } catch (err) {
      setActionError(err);
    } finally {
      setLicensing(false);
    }
  };

  return (
    <div className="song-page">
      <div className="song-spread">
        <div className="song-spread__stagewrap">
          <div className="song-spread__cover">
          <CoverArt
            seed={song.coverSeed}
            title={song.title}
            styles={song.styles}
            size={560}
            className="song-spread__art"
            playing={playing}
          />
          <button
            type="button"
            className={`song-spread__play${active ? ' is-active' : ''}`}
            onClick={active ? player.toggle : play}
            disabled={!song.previewUrl}
            aria-label={active ? t('song.pause') : t('song.play')}
          >
            <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
            {playing ? t('song.pause') : t('song.play')}
          </button>
          </div>
        </div>

        <div className="song-spread__info">
          <p className="eyebrow song-spread__eyebrow">
            {t(song.visibility === 'public' ? 'song.public' : isOwner ? 'song.private' : 'song.work')} ·{' '}
            {t(song.vocalMode === 'instrumental' ? 'song.instrumental' : 'song.vocals')} · {formatTime(song.durationSeconds)}
          </p>
          <h1 className="song-spread__title">{song.title}</h1>
          <p className="song-spread__meta">
            {/* No play count. Plays are still recorded server-side, because the
                operations dashboard needs to know what gets listened to — but
                showing the number turns a private song into a performance, and
                a song with two plays into a failure. */}
            {song.artistName ?? t(isOwner ? 'song.you' : 'song.creator')}
            {song.styles.length > 0 && <> · {song.styles.join(' / ')}</>}
          </p>

          <div className="song-spread__actions" aria-label={t('song.actions.aria')}>
            {song.visibility === 'public' && (
              <ShareMenu url={`${window.location.origin}/song/${song.trackId}`} title={song.title} />
            )}
            {isOwner && (
              <>
                <Link className="text-action" to={`/create?edit=${song.trackId}`}>
                  {t('song.edit')}
                </Link>
                <button type="button" className="text-action" onClick={download} disabled={busy}>
                  {t('song.download')}
                </button>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setVisibility(song.visibility === 'public' ? 'private' : 'public')}
                  disabled={busy}
                >
                  {t(song.visibility === 'public' ? 'song.unpublish' : 'song.publish')}
                </button>
                <button
                  type="button"
                  className="text-action is-danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t('song.delete')}
                </button>
              </>
            )}
            {/* A reader with no account (a shared link) can listen; buying a
                licence needs an account, so say that instead of showing a
                dead, disabled button. */}
            {!me && song.visibility === 'public' && song.state === 'deliverable' && (
              <Link className="text-action is-strong" to={`/auth?next=${encodeURIComponent(`/song/${song.trackId}`)}`}>
                {t('song.signInToLicense')}
              </Link>
            )}
            {me && !isOwner && song.visibility === 'public' && song.state === 'deliverable' && (
              song.licensedByMe ? (
                <button type="button" className="text-action" onClick={download} disabled={busy}>
                  {t('song.downloadLicensed')}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-action is-strong"
                  onClick={buyLicense}
                  disabled={licensing || !me || licenseProduct === null}
                  /* No `title`: it is not a reliable accessible name and never
                     reaches touch users. The one here was also a hardcoded
                     Chinese literal promising "创作者获得 70%" — a revenue share
                     migration 0005 removed. The string outlived the feature. */
                  aria-label={
                    licenseProduct
                      ? t('song.license.aria', {
                          price: formatMoney(licenseProduct.amountMinor, licenseProduct.currency, LOCALES[lang]),
                        })
                      : t('song.license.unavailable')
                  }
                >
                  {licensing
                    ? t('song.licensing')
                    : licenseProduct
                      ? t('song.license', {
                          price: formatMoney(licenseProduct.amountMinor, licenseProduct.currency, LOCALES[lang]),
                        })
                      : t('song.license.unavailable')}
                </button>
              )
            )}
          </div>

          {/* Beside the buttons that caused it, not in place of the page. */}
          <ErrorNotice error={actionError} />

          {song.licenseCount > 0 && (
            <p className="song-spread__note">{t('song.licensesSold', { n: song.licenseCount })}</p>
          )}
          {runtime?.syntheticAudio && <p className="song-spread__note">{t('song.demo')}</p>}

          <div className="song-spread__player">
            <span className="song-spread__time num">
              {formatTime(active ? player.currentTime : 0)} / {formatTime(song.durationSeconds)}
            </span>
            <Score
              score={songScore ?? undefined}
              head={active && player.duration ? player.currentTime / player.duration : 0}
              onSeek={
                song.previewUrl
                  ? (f) => {
                      if (!active) void play();
                      player.seek(f * (player.duration || song.durationSeconds));
                    }
                  : undefined
              }
              className="song-spread__score"
              height={104}
              label={t('song.transport', { title: song.title })}
            />
          </div>
        </div>
      </div>

      {song.lyrics && (
        <section className="song-page__lyrics panel" aria-labelledby="lyrics-heading">
          <h2 id="lyrics-heading">{t('song.lyrics')}</h2>
          {/*
            * Only while THIS song is the one playing. The readout above has
            * always guarded on `active`; these two props did not, so opening
            * song B while song A played highlighted and auto-scrolled B's
            * lines in time with A.
            */}
          <SyncedLyrics
            lyrics={song.lyrics}
            duration={active ? player.duration || song.durationSeconds : song.durationSeconds}
            currentTime={active ? player.currentTime : 0}
            timings={song.lyricTimings}
            title={song.title}
            artist={song.artistName}
            onSeek={active ? player.seek : undefined}
            onSaveTimings={
              isOwner
                ? async (timings) => {
                    const saved = await apiFetch<{ lyricTimings: LyricTimings }>(
                      `/v1/tracks/${song.trackId}/lyric-timings`,
                      { method: 'POST', body: timings },
                    );
                    setSong((s) => (s ? { ...s, lyricTimings: saved.lyricTimings } : s));
                  }
                : undefined
            }
          />
        </section>
      )}

      {/* The terms record stays one click away for the owner, but as a quiet
          footnote: a full panel for it read as a warning stuck to every song. */}
      {isOwner && (
        <p className="song-page__terms">
          <Link to={`/tracks/${song.trackId}/license`} className="quiet-link">
            {t('song.usage')} ↗
          </Link>
        </p>
      )}
    </div>
  );
}
