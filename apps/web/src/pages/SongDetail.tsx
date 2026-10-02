import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TITLE_MAX_CODEPOINTS, type LyricTimings, type ProductView, type TrackView } from '@yuha/contracts';
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
  /*
   * Renaming. The title was chosen once, at generation, by someone who had not
   * heard the song yet, so it is the one piece of a finished song that most
   * wants changing — and until now the only way was to generate another one.
   */
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [renameError, setRenameError] = useState<unknown>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
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
    // Focus follows the field that just appeared, and selects what is there so
    // a replacement name can be typed straight over the old one. Without this
    // the reader has to find a freshly rendered input with the pointer, and a
    // keyboard reader never finds it at all.
    if (!renaming) return;
    const el = titleInput.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renaming]);

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


  /*
   * The server collapses whitespace and trims; this mirrors it only to decide
   * whether Save is worth offering. The stored value is whatever the server
   * decides, and the response is what is written back — never this string.
   */
  const tidyTitle = (v: string) => v.replace(/\s+/g, ' ').trim();
  const titleLength = [...tidyTitle(draftTitle)].length;
  const titleAtLimit = titleLength >= TITLE_MAX_CODEPOINTS;
  const titleUnchanged = tidyTitle(draftTitle) === song.title;
  const canSaveTitle = titleLength > 0 && titleLength <= TITLE_MAX_CODEPOINTS && !titleUnchanged;

  const openRename = () => {
    setRenameError(null);
    setDraftTitle(song.title);
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
    setRenameError(null);
    // Put focus back where it came from; leaving it on a removed input drops
    // a keyboard reader at the top of the document.
    window.requestAnimationFrame(() => renameButton.current?.focus());
  };

  const saveTitle = async () => {
    if (!canSaveTitle) return;
    setBusy(true);
    setRenameError(null);
    try {
      const res = await apiFetch<{ title: string }>(`/v1/tracks/${song.trackId}/title`, {
        method: 'POST',
        body: { title: draftTitle },
      });
      // The server's value, not the typed one: it trims and collapses, and the
      // page should show what is stored rather than what was typed at it.
      setSong({ ...song, title: res.title });
      setRenaming(false);
      window.requestAnimationFrame(() => renameButton.current?.focus());
    } catch (err) {
      // Stay open with the text intact. A refusal that closed the field would
      // throw away the writing and leave nothing to correct.
      setRenameError(err);
    } finally {
      setBusy(false);
    }
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
          {renaming ? (
            /*
             * The heading swaps in place, at the same type scale, so the page
             * does not jump under the reader's hands when the field opens.
             * `h1` stays: it is still the page's heading while it is being
             * edited, and a document that loses its h1 mid-interaction loses
             * the landmark a screen reader navigates by.
             */
            <h1 className="song-spread__title song-spread__title--editing">
              <input
                ref={titleInput}
                type="text"
                value={draftTitle}
                maxLength={TITLE_MAX_CODEPOINTS}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  // Enter saves and Escape cancels, because this is a
                  // one-field form and reaching for a button to commit one
                  // line is the slow path. Both still have buttons below.
                  if (e.key === 'Enter') { e.preventDefault(); void saveTitle(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                }}
                className={titleAtLimit ? 'is-full' : undefined}
                aria-label={t('song.rename.label')}
                aria-describedby="rename-count rename-error"
                autoComplete="off"
                enterKeyHint="done"
              />
            </h1>
          ) : (
            <h1 className="song-spread__title">{song.title}</h1>
          )}
          {renaming && (
            <div className="song-spread__rename">
              <div className={`composer__meta${titleAtLimit ? ' is-full' : ''}`}>
                <span id="rename-count" className="num" aria-live="polite">
                  {titleLength} / {TITLE_MAX_CODEPOINTS}
                </span>
              </div>
              {/*
                The refusal sits under the field it is about, not at the top of
                the page: an error the reader has to go looking for is an error
                they act on last. `ErrorNotice` already carries role="alert".
              */}
              <div id="rename-error">
                <ErrorNotice error={renameError} />
              </div>
              <div className="song-spread__rename-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void saveTitle()}
                  disabled={busy || !canSaveTitle}
                >
                  {busy ? t('song.rename.saving') : t('song.rename.save')}
                </button>
                <button type="button" className="text-action" onClick={cancelRename} disabled={busy}>
                  {t('song.rename.cancel')}
                </button>
              </div>
            </div>
          )}
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
                {/*
                  A named action rather than a pencil that appears on hover:
                  this page is read on phones, where there is no hover at all,
                  and the row beside it already speaks in plain verbs.
                */}
                {!renaming && (
                  <button
                    type="button"
                    ref={renameButton}
                    className="text-action"
                    onClick={openRename}
                    disabled={busy}
                  >
                    {t('song.rename')}
                  </button>
                )}
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
