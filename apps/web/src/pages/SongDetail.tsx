import { TRIAL_CLAIMED_EVENT, guestSongId } from '../lib/guest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { TITLE_MAX_CODEPOINTS, seasonOfOccasion, type Occasion, type ProductView, type TrackView } from '@yuha/contracts';
import { API_BASE, ApiError, apiFetch, apiPostForBlob } from '../lib/api';
import { drawVideoFrame, frameJpeg, planShareClip, shareCardPng } from '../lib/share-art';
import { resolveLyricTimings, sungLyrics, timedLinesFor } from '../lib/lyrics';
import { useLyricSyncRefresh } from '../lib/lyric-sync-refresh';
import { clampToCodePoints } from '../lib/codepoints';
import { createInFlightGuard, PENDING_AFTER_MS } from '../lib/in-flight';
import { formatTime, usePlayer } from '../lib/player';
import { HolidayOpening } from '../components/HolidayOpening';
import { fetchProducts, findLicenceProduct } from '../lib/catalog';
import { styleLabel } from '../lib/style-label';
import { useI18n } from '../lib/i18n';
import { LOCALES, formatMoney } from '../lib/money';
import { useSession } from '../lib/session';
import { canBePaid } from '../lib/purchase';
import { CoverArt } from '../components/CoverArt';
import { DedicationEditor } from '../components/DedicationEditor';
import { IssueReport } from '../components/IssueReport';
import { ErrorNotice } from '../components/common';
import { Score } from '../components/Score';
import { ShareMenu } from '../components/ShareMenu';
import { PhotoVideo } from '../components/PhotoVideo';
import { SceneMv } from '../components/SceneMv';
import { useConfirm } from '../components/ConfirmDialog';
import { SyncedLyrics } from '../components/SyncedLyrics';
import { LyricAutoSync } from '../components/LyricAutoSync';
import { GiftInvitations } from '../components/GiftInvitations';
import { scoreFromSeed } from '../lib/score';
import { usePageTitle } from '../lib/title';
import { shareCreateHref } from '../lib/create-link';

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
  const strictTimeline = Boolean(runtime?.features?.lyricStrictTimeline);
  const player = usePlayer();
  const sceneSeek = useRef<number | null>(null);
  useEffect(() => { sceneSeek.current = null; }, [id]);
  useEffect(() => {
    if (player.activeId === id && player.duration > 0 && sceneSeek.current !== null) {
      player.seek(sceneSeek.current);
      sceneSeek.current = null;
    }
  }, [id, player.activeId, player.duration, player.seek]);
  const [confirm, confirmDialog] = useConfirm();
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
  /** "Send it to them" just published the song: open its share menu straight away. */
  const [sendNow, setSendNow] = useState(false);
  /** The look of the song whose share card was last uploaded (see uploadCard). */
  const cardSent = useRef<string | null>(null);
  /*
   * The card goes up as soon as an owner's song is public — on load and the
   * moment it is published — not only when the share menu opens: a link
   * copied in the first second would otherwise be fetched by a crawler
   * before the card exists, and X, Facebook and LINE keep the first preview
   * they see. `uploadCard` is defined below the loading return; the ref
   * carries it up here.
   */
  const uploadCardRef = useRef<() => void>(() => undefined);
  /*
   * `?share=1` — "分享" from a card's menu in the library. Opens the share
   * menu; a private song is offered for publishing first, with the same
   * warning "送给 TA" gives. Once per arrival, then dropped from the address.
   */
  const [params, setParams] = useSearchParams();
  const shareIntentRef = useRef<() => void>(() => undefined);
  const shareHandled = useRef(false);
  useEffect(() => {
    // `me` too: on a cold load the song can arrive before the session, and the
    // intent must not be spent before we know whether this is the owner.
    if (!song || !me || shareHandled.current || params.get('share') !== '1') return;
    shareHandled.current = true;
    shareIntentRef.current();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('share');
      return next;
    }, { replace: true });
  }, [song, me, params, setParams]);
  useEffect(() => {
    if (song && me?.userId === song.artistId && song.visibility === 'public' && song.state === 'deliverable') {
      uploadCardRef.current();
    }
  }, [song, me?.userId]);
  /*
   * Renaming. The title was chosen once, at generation, by someone who had not
   * heard the song yet, so it is the one piece of a finished song that most
   * wants changing — and until now the only way was to generate another one.
   */
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [renameError, setRenameError] = useState<unknown>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadGuard = useRef(createInFlightGuard());
  const renameButton = useRef<HTMLButtonElement>(null);
  const [editingGift, setEditingGift] = useState(false);
  /** The private problem report (docs/ISSUE_REPORTS_SPEC.md); a prefill when opened from a failure. */
  const [reporting, setReporting] = useState<null | { kind?: 'download_failed'; requestId?: string | null }>(null);
  const giftEditButton = useRef<HTMLButtonElement>(null);
  const giftEditWasOpen = useRef(false);
  // Focus goes back to "edit" when the editor closes, once the button is
  // back in the document: focus left on a removed field drops a keyboard
  // reader at the top of the page.
  useEffect(() => {
    if (editingGift) giftEditWasOpen.current = true;
    else if (giftEditWasOpen.current) {
      giftEditWasOpen.current = false;
      giftEditButton.current?.focus();
    }
  }, [editingGift]);
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

  /*
   * While the platform syncs this song's lyrics (L4a/L4b), ask again every
   * 12 s, only while the page is in front, and take just the timeline and its
   * state: the player is not touched, so the music keeps playing and the
   * highlight picks up at the current position; the video card reads the
   * same `song.lyricTimings`, so an export uses what is shown. Nobody saves.
   */
  const syncing = song?.lyricSync === 'syncing';
  /*
   * What the lyrics heading says (docs/agents/LYRIC_AUTO_SYNC_UX_HANDOFF.md):
   * the state while it needs saying, and "synced" only at the moment a sync
   * this page watched completes — never as a standing badge. `idle` (nothing
   * tried: not in scope, or not yet) promises nothing.
   */
  const lastSync = useRef<string | null | undefined>(undefined);
  const [justSynced, setJustSynced] = useState(false);
  useEffect(() => {
    const was = lastSync.current;
    lastSync.current = song?.lyricSync;
    if (was === 'syncing' && song?.lyricSync === 'synced') {
      setJustSynced(true);
      const timer = window.setTimeout(() => setJustSynced(false), 6000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [song?.lyricSync]);
  useEffect(() => {
    lastSync.current = undefined;
    setJustSynced(false);
  }, [id]);
  const syncNote =
    song?.lyricSync === 'syncing' || song?.lyricSync === 'partial' || song?.lyricSync === 'deferred' || song?.lyricSync === 'unavailable'
      ? song.lyricSync
      : justSynced
        ? 'synced'
        : null;
  // The shared refresh (lib/lyric-sync-refresh.ts): this page and Now Playing take the same timeline.
  useLyricSyncRefresh(song?.trackId ?? null, syncing, (fresh) =>
    setSong((s) =>
      s && s.trackId === fresh.trackId && (s.lyricSync !== fresh.lyricSync || s.lyricTimings !== fresh.lyricTimings)
        ? { ...s, lyricSync: fresh.lyricSync, lyricTimings: fresh.lyricTimings }
        : s,
    ),
  );
  // A trial song just added to this account (TrialClaimAsk): read it again,
  // so the page shows the song instead of the "not found" it had a moment ago.
  useEffect(() => {
    const onClaimed = () => load();
    window.addEventListener(TRIAL_CLAIMED_EVENT, onClaimed);
    return () => window.removeEventListener(TRIAL_CLAIMED_EVENT, onClaimed);
  }, [load]);

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
    // The song this browser made before signing in: the account that just
    // signed in does not own it yet, so the API says "not found". That is not
    // the news — the prompt above (TrialClaimAsk) is how it becomes theirs.
    if (me && me.role !== 'guest' && id && guestSongId() === id && error instanceof ApiError && error.status === 404) {
      return (
        <div className="stack">
          <p className="panel" style={{ margin: 0 }}>{t('trial.claim.pendingHere')}</p>
        </div>
      );
    }
    // A song link that does not open is usually one sent before it was made
    // public, opened by somebody with no library to go back to (UX audit #17):
    // say that, not "choose again from your library".
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="stack">
          <div className="alert alert--warn" role="alert">
            <div className="alert__title">{t('song.notFound.title')}</div>
            <div>{t('song.notFound.next')}</div>
          </div>
          <Link to={me ? '/library' : '/'} className="btn">
            {t(me ? 'song.backMarket' : 'song.backHome')}
          </Link>
        </div>
      );
    }
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
  /*
   * The owner, with an account. A trial's owner (docs/GROWTH_SPEC.md, part
   * three) can play, publish and share its song; renaming, editing,
   * downloading, deleting and the rest wait for signing up.
   */
  const manages = isOwner && me?.role !== 'guest';
  const active = player.activeId === song.trackId;
  // The words this song sings, or null: an instrumental, or a song sung
  // without words, has no lyric sync anywhere on this page (lib/lyrics.ts).
  const sung = sungLyrics(song);
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

  const setVisibility = async (visibility: 'public' | 'private'): Promise<boolean> => {
    // Only "send it to them" opens the menu by itself, and only that once.
    setSendNow(false);
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}/visibility`, { method: 'POST', body: { visibility } });
      setSong({ ...song, visibility });
      return true;
    } catch (err) {
      // There was no catch: offline, the menu kept the old label and said
      // nothing, so publishing appeared to work and had not.
      setActionError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /*
   * "Send it to them" on a private gift: sending means the link has to open,
   * so say that before doing it (docs/GIFT_AND_SHARE_SPEC.md), then open the
   * share menu on the published song.
   */
  const sendGift = async () => {
    if (!(await confirm({ message: t('song.gift.confirmPublic'), confirmLabel: t('song.gift.send') }))) return;
    if (await setVisibility('public')) setSendNow(true);
  };

  /*
   * The link preview's picture, drawn here and uploaded when the owner opens
   * the share menu — before they can pick where to post, so it is in place by
   * the time a crawler asks. Once per look of the song: a rename or a gift
   * line changes the picture, a second open does not.
   */
  /** The words on the share card and the video frames, in the reader's language. */
  const shareLabels = () => {
    const d = song.dedication;
    return {
      site: t('share.card.site'),
      lang,
      ...(d
        ? { to: t('song.gift.to', { to: d.to }), ...(d.occasion !== 'other' ? { occasion: t(`gift.line.${d.occasion}`) } : {}) }
        : { detail: song.styles.map((x) => styleLabel(x, t)).join(' / ') }),
    };
  };

  /*
   * The share video (docs/GIFT_AND_SHARE_SPEC.md): twenty seconds from the
   * chorus, each sung line on its own frame, drawn here and put on the song's
   * audio by the API. Returned as a file for the phone's share sheet.
   */
  const makeVideo = async (seconds: number): Promise<File> => {
    // Only trusted lines are drawn under the shared rule (isTrustedLine); an estimate makes a video without words.
    const lines = sung ? timedLinesFor(resolveLyricTimings(sung, song.durationSeconds, song.lyricTimings), strictTimeline) : [];
    const plan = planShareClip(lines, song.durationSeconds, 200, seconds);
    const labels = shareLabels();
    const frames = [];
    for (const f of plan.frames) {
      const canvas = await drawVideoFrame(song, labels, f.line, (plan.start + f.at) / song.durationSeconds);
      frames.push({ at: f.at, jpeg: await frameJpeg(canvas) });
    }
    const blob = await apiPostForBlob(`/v1/tracks/${song.trackId}/share-video`, { start: plan.start, duration: plan.duration, frames });
    const name = `${song.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'yuha'}.mp4`;
    return new File([blob], name, { type: 'video/mp4' });
  };

  const uploadCard = () => {
    const d = song.dedication;
    const look = JSON.stringify([song.title, song.coverSeed, song.styles, d, lang]);
    if (cardSent.current === look) return;
    cardSent.current = look;
    void shareCardPng(song, shareLabels())
      .then((png) => apiFetch(`/v1/tracks/${song.trackId}/share-card`, { method: 'PUT', body: { png } }))
      .catch(() => {
        // The post still works with the site's own picture; try again next open.
        cardSent.current = null;
      });
  };
  uploadCardRef.current = uploadCard;
  shareIntentRef.current = () => {
    if (!isOwner || song.state !== 'deliverable') return;
    if (song.visibility === 'public') {
      setSendNow(true);
      return;
    }
    void confirm({
      message: t(song.dedication ? 'song.gift.confirmPublic' : 'song.share.confirmPublic'),
      confirmLabel: t(song.dedication ? 'song.gift.send' : 'song.share.publishOk'),
    }).then((yes) => yes && setVisibility('public').then((ok) => ok && setSendNow(true)));
  };
  const shareUrl = `${API_BASE || window.location.origin}/v1/share/songs/${song.trackId}`;
  const shareText = song.dedication
    ? t('song.gift.shareText', { to: song.dedication.to, title: song.title })
    : undefined;

  const remove = async () => {
    if (!(await confirm({ message: t('song.confirmDelete', { title: song.title }), confirmLabel: t('song.delete'), danger: true }))) return;
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
    /*
     * `disabled={busy}` alone lets two presses inside one frame both through:
     * the flag is React state and does not apply until the next render. The
     * ref decides at the moment of the press. The full-screen player had
     * neither, and the song came down several times because of it.
     */
    if (!downloadGuard.current.begin()) return;
    setBusy(true);
    setActionError(null);
    /*
     * Deferred, not immediate. The export answers in about 12ms against a
     * local API, so showing it at once made the label swap and swap back
     * inside a frame — a flicker reads as a glitch and is worse than silence.
     * The guard above is already blocking the second press; this only decides
     * when to say so.
     */
    const pendingTimer = window.setTimeout(() => setDownloading(true), PENDING_AFTER_MS);
    try {
      const res = await apiFetch<{ downloadUrl: string }>(`/v1/tracks/${song.trackId}/exports`, {
        method: 'POST',
        body: { clipStartSeconds: 0, clipDurationSeconds: Math.round(song.durationSeconds), fadeOut: false },
      });
      window.location.href = res.downloadUrl;
    } catch (err) {
      setActionError(err);
    } finally {
      // Always, including after a failure: one network blip must not disable
      // download for the rest of the session.
      window.clearTimeout(pendingTimer);
      downloadGuard.current.end();
      setDownloading(false);
      setBusy(false);
    }
  };

  /*
   * Through the confirmation screen, like every other purchase: it states the
   * seller and terms and offers the methods the server lists for the licence
   * (docs/PAYMENTS_DESIGN.md). This button used to pick a channel itself.
   */
  const licenseOpen = licenseProduct !== null && canBePaid(licenseProduct);
  const buyLicense = () => {
    if (!me || !licenseOpen) return;
    navigate(`/checkout/confirm?price=market_license&track=${encodeURIComponent(song.trackId)}`);
  };

  // A holiday song opened by the person it was written for (docs/HOLIDAY_SPEC.md).
  const giftSeason = !isOwner && song.dedication ? seasonOfOccasion(song.dedication.occasion) : null;
  const trialUnits = runtime?.features.freeTrialEnabled ? runtime.features.freeTrialUnits : 0;

  return (
    <div className="song-page">
      {confirmDialog}
      {giftSeason && song.dedication && (
        <HolidayOpening trackId={song.trackId} season={giftSeason} to={song.dedication.to} onOpen={play} />
      )}
      <div className="song-spread">
        <div className="song-spread__stagewrap">
          <div className="song-spread__cover">
          <CoverArt
            seed={song.coverSeed}
            title={song.title}
            styles={song.styles}
            // The reading is computed from mood and voice as well as styles;
            // without these the song page showed 55°YU for a song the player
            // bar, the card and Now Playing all called 87°.
            mood={song.mood}
            vocalMode={song.vocalMode}
            size={560}
            className="song-spread__art"
            playing={playing}
          />
          <button
            type="button"
            className={`song-spread__play${active ? ' is-active' : ''}`}
            onClick={active ? player.toggle : play}
            disabled={!song.previewUrl}
            aria-label={playing ? t('song.pause') : t('song.play')}
          >
            <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
            {playing ? t('song.pause') : t('song.play')}
          </button>
          </div>
        </div>

        <div className="song-spread__info">
          {song.dedication && editingGift && isOwner ? (
            <DedicationEditor
              trackId={song.trackId}
              dedication={song.dedication}
              onSaved={(dedication) => {
                // The page's own card upload notices the change (its key
                // includes the dedication) and draws the card again.
                setSong({ ...song, dedication });
                setEditingGift(false);
              }}
              onCancel={() => setEditingGift(false)}
            />
          ) : (
            song.dedication && (
              <div className="song-gift">
                <span className="song-gift__to">{t('song.gift.to', { to: song.dedication.to })}</span>
                {song.dedication.occasion !== 'other' && (
                  <strong className="song-gift__line">{t(`gift.line.${song.dedication.occasion}`)}</strong>
                )}
                {song.dedication.note && <p className="song-gift__note">{song.dedication.note}</p>}
                {manages && (
                  <button
                    type="button"
                    ref={giftEditButton}
                    className="text-action song-gift__edit"
                    onClick={() => setEditingGift(true)}
                  >
                    {t('song.gift.edit')}
                  </button>
                )}
              </div>
            )
          )}
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
                onChange={(e) =>
                  setDraftTitle(clampToCodePoints(e.target.value, TITLE_MAX_CODEPOINTS))
                }
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
            {song.styles.length > 0 && <> · {song.styles.map((s) => styleLabel(s, t)).join(' / ')}</>}
          </p>

          {/*
            Two groups, not one wrapping row with `margin-left: auto` on the
            destructive button. That pushed Delete to the right-hand end of
            *whichever line it happened to land on*, so on a narrow screen it
            sat wherever the wrap put it. Grouping separates it the same way at
            every width: beside the others when there is room, on its own line
            when there is not.
          */}
          <div className="song-spread__actions" role="group" aria-label={t('song.actions.aria')}>
            <div className="song-spread__actions-main">
            {song.visibility === 'public' && (
              <ShareMenu
                /*
                 * One menu per song. The SPA keeps this page mounted when it
                 * moves from song A to song B, and the menu kept A's finished
                 * video, ready to send under B's text — or A's video landed
                 * on B when it finished making after the move (review R2).
                 */
                key={song.trackId}
                url={shareUrl}
                title={song.title}
                text={shareText}
                primary={isOwner}
                label={isOwner && song.dedication ? t('song.gift.send') : undefined}
                autoOpen={sendNow}
                onOpen={isOwner ? uploadCard : undefined}
              />
            )}
            {isOwner && song.dedication && song.visibility !== 'public' && song.state === 'deliverable' && (
              <button type="button" className="text-action is-strong" onClick={() => void sendGift()} disabled={busy}>
                {t('song.gift.send')}
              </button>
            )}
            {isOwner && (
              <>
                {/*
                  A named action rather than a pencil that appears on hover:
                  this page is read on phones, where there is no hover at all,
                  and the row beside it already speaks in plain verbs.
                */}
                {manages && !renaming && (
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
                {manages && (
                  <Link className="text-action" to={`/create?edit=${song.trackId}`}>
                    {t('song.edit')}
                  </Link>
                )}
                {manages && (
                <button
                  type="button"
                  className="text-action"
                  onClick={download}
                  disabled={busy}
                  aria-busy={downloading}
                >
                  {downloading ? t('song.downloading') : t('song.download')}
                </button>
                )}
                {/*
                  The one filled action, and only while the song is private:
                  a finished song nobody can open is a song that is not
                  finished. Once it is public the primary moves to Share, and
                  unpublishing goes quiet — taking it back should not be the
                  most inviting thing on the page.
                */}
                <button
                  type="button"
                  className={`text-action${song.visibility === 'public' || song.dedication ? '' : ' is-strong'}`}
                  onClick={() => {
                    // Taking a link back is instant; opening it asks, like Share does (UX audit #29).
                    if (song.visibility === 'public') {
                      void setVisibility('private');
                      return;
                    }
                    void confirm({
                      message: t(song.dedication ? 'song.gift.confirmPublic' : 'song.share.confirmPublic'),
                      confirmLabel: t('song.share.publishOk'),
                    }).then((yes) => yes && setVisibility('public'));
                  }}
                  disabled={busy}
                >
                  {t(song.visibility === 'public' ? 'song.unpublish' : 'song.publish')}
                </button>
              </>
            )}
            {/* A reader with no account (a shared link) can listen; buying a
                licence needs an account, so say that instead of showing a
                dead, disabled button. */}
            {!me && song.visibility === 'public' && song.state === 'deliverable' && (
              /* Quiet: on a song somebody was sent, the way in is "write one too",
                 not a licence (docs/GROWTH_SPEC.md, part two). */
              <Link className="text-action" to={`/auth?next=${encodeURIComponent(`/song/${song.trackId}`)}`}>
                {t('song.signInToLicense')}
              </Link>
            )}
            {me && !isOwner && song.visibility === 'public' && song.state === 'deliverable' && (
              song.licensedByMe ? (
                <button
                  type="button"
                  className="text-action"
                  onClick={download}
                  disabled={busy}
                  aria-busy={downloading}
                >
                  {downloading ? t('song.downloading') : t('song.downloadLicensed')}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-action is-strong"
                  onClick={buyLicense}
                  disabled={!me || licenseProduct === null || !licenseOpen}
                  /* No `title`: it is not a reliable accessible name and never
                     reaches touch users. The one here was also a hardcoded
                     Chinese literal promising "创作者获得 70%" — a revenue share
                     migration 0005 removed. The string outlived the feature. */
                  aria-label={
                    licenseProduct && !licenseOpen
                      ? t('song.license.cardClosed')
                      : licenseProduct
                      ? t('song.license.aria', {
                          price: formatMoney(licenseProduct.amountMinor, licenseProduct.currency, LOCALES[lang]),
                        })
                      : t('song.license.unavailable')
                  }
                >
                  {licenseProduct && !licenseOpen
                      ? t('song.license.cardClosed')
                    : licenseProduct
                      ? t('song.license', {
                          price: formatMoney(licenseProduct.amountMinor, licenseProduct.currency, LOCALES[lang]),
                        })
                      : t('song.license.unavailable')}
                </button>
              )
            )}
            </div>
          </div>

          {/* A song someone was given: recommend the licence, saying what it gives
              (product decision 2026-11-25). Only what is true of every licence:
              the MP3 can be downloaded, and the licence is recorded in your name. */}
          {!isOwner && song.dedication && song.visibility === 'public' && song.state === 'deliverable' && !song.licensedByMe && (
            <p className="song-spread__license-pitch">{t('song.license.giftPitch')}</p>
          )}

          {/* A trial's song: kept only by signing up (docs/GROWTH_SPEC.md, part three). */}
          {isOwner && !manages && (
            <div className="trial-keep">
              <h2>{t('trial.keep.title')}</h2>
              <p>{t('trial.keep.body')}</p>
              {/* Only what the welcome grant will really give: none when it is off (lib: freeTrialAvailable). */}
              {runtime?.features.freeTrialEnabled && runtime.features.freeTrialUnits > 1 && (
                <p>{t('trial.keep.more', { n: runtime.features.freeTrialUnits - 1 })}</p>
              )}
              <Link className="btn btn--primary" to={`/auth?next=${encodeURIComponent(`/song/${song.trackId}`)}`}>
                {t('trial.keep.cta')}
              </Link>
            </div>
          )}

          {/* A music gift invitation (docs/GIFT_INVITATION_PLAN.md): a link of its
              own, revocable, and no need to make the song public. */}
          {manages && song.state === 'deliverable' && <GiftInvitations trackId={song.trackId} title={song.title} coverSeed={song.coverSeed} styles={song.styles ?? []} />}

          {/* The photo MV (docs/PHOTO_MV_SPEC.md): the owner's, once the song plays,
              and only where the switch is on. */}
          {manages && song.state === 'deliverable' && (
            <PhotoVideo
              song={song}
              labels={shareLabels()}
              lyrics={sung}
              lyricTimings={song.lyricTimings}
              makeCoverVideo={makeVideo}
              startOpen={params.get('video') === '1'}
              photosEnabled={runtime?.features.photoVideoEnabled === true || runtime?.features.photoVideoPreview === true}
              sceneMv={runtime?.features.sceneMv === true ? (visible) => (
                <SceneMv key={song.trackId} trackId={song.trackId} title={song.title} duration={song.durationSeconds}
                  visible={visible}
                  timings={song.lyricTimings ?? null}
                  onListen={(start) => {
                    if (active && player.duration > 0) {
                      player.seek(start);
                      if (player.status !== 'playing') player.toggle();
                    } else { sceneSeek.current = start; play(); }
                  }}
                  onVideoPlay={() => { if (player.status === 'playing') player.toggle(); }}
                />
              ) : undefined}
            />
          )}
          {/* A trial's song cannot be made into a video yet; say that it can, once kept. */}
          {isOwner && !manages && song.state === 'deliverable' && (
            <section className="photo-video photo-video--closed" aria-labelledby="photo-video-title">
              <h2 id="photo-video-title">{t('video.title')}</h2>
              <p className="photo-video__lead">{t(runtime?.features.photoVideoEnabled ? 'video.lead' : 'video.leadCover')}</p>
              <p className="photo-video__lead">{t('photo.afterSignup')}</p>
            </section>
          )}

          {/* Beside the buttons that caused it, not in place of the page. */}
          <ErrorNotice error={actionError} />
          {/* A failure the owner cannot fix is one they report, with its request id attached. */}
          {manages && actionError instanceof ApiError && actionError.requestId && !reporting && (
            <button
              type="button"
              className="text-action"
              onClick={() => setReporting({ kind: 'download_failed', requestId: actionError.requestId })}
            >
              {t('issue.reportThis')}
            </button>
          )}
          {manages && reporting && (
            <IssueReport
              trackId={song.trackId}
              currentSeconds={active ? player.currentTime : null}
              prefill={reporting.kind ? { kind: reporting.kind, requestId: reporting.requestId ?? null } : undefined}
              onClose={() => setReporting(null)}
            />
          )}
          {/*
            The rarely-needed actions, last and together. Delete used to sit in
            the row with Share and Download, as large as either: on a phone it
            was the third thing under the thumb. It is findable here, outlined
            in red, and nowhere near the things people come to do.
          */}
          {manages && (
            <div className="song-spread__manage">
              {!reporting && song.state === 'deliverable' && (
                <button type="button" className="text-action song-spread__report" onClick={() => setReporting({})}>
                  {t('issue.open')}
                </button>
              )}
              <button type="button" className="text-action is-danger" disabled={busy} onClick={() => void remove()}>
                {t('song.delete')}
              </button>
            </div>
          )}

          {/* The owner's to know, nobody else's: shown to a visitor it was a public
              counter (CLAUDE.md, Scope decisions; docs/GROWTH_SPEC.md). */}
          {isOwner && song.licenseCount > 0 && (
            <p className="song-spread__note">{t('song.licensesSold', { n: song.licenseCount })}</p>
          )}
          {runtime?.syntheticAudio && <p className="song-spread__note">{t('song.demo')}</p>}

          {/*
            Somebody who was sent a song is the person most likely to want to
            send one. Not shown to the owner, who is already here for that.
          */}
          {!isOwner && song.visibility === 'public' && (
            <p className="song-gift__again">
              <WriteOneToo occasion={song.dedication?.occasion} />
            </p>
          )}

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

      {sung && (
        <section className="song-page__lyrics panel" aria-labelledby="lyrics-heading">
          <h2 id="lyrics-heading">{t('song.lyrics')}</h2>
          {/* Always present, so a screen reader announces a change once and a poll that changes nothing says nothing. */}
          <p className="lyrics-sync__status" role="status" aria-live="polite">
            {syncNote ? t(`lyrics.sync.${syncNote}`) : null}
          </p>
          {manages && runtime?.features.lyricAutoAlign && song.state === 'deliverable'
            && song.lyricTimings?.source !== 'corrected' && (
              <LyricAutoSync key={song.trackId} trackId={song.trackId} syncing={syncing} />
            )}
          {/*
            * Only while THIS song is the one playing. The readout above has
            * always guarded on `active`; these two props did not, so opening
            * song B while song A played highlighted and auto-scrolled B's
            * lines in time with A.
            */}
          <SyncedLyrics
            lyrics={sung}
            duration={active ? player.duration || song.durationSeconds : song.durationSeconds}
            currentTime={active ? player.currentTime : 0}
            live={active}
            still={song.lyricSync === 'syncing' && !song.lyricTimings}
            timings={song.lyricTimings}
            title={song.title}
            artist={song.artistName}
            onSeek={active ? player.seek : undefined}
            canDownload={manages}
          />
        </section>
      )}

      {/* After the lyrics, where a listener ends up: the same way in again.
          Only after lyrics: with none, it sat right under the first button. */}
      {!isOwner && song.visibility === 'public' && sung && (
        <section className="song-again" aria-labelledby="song-again-heading">
          <h2 id="song-again-heading">{t(song.dedication ? 'song.again.lead' : 'song.again.lead.plain')}</h2>
          <WriteOneToo occasion={song.dedication?.occasion} />
          {trialUnits > 0 && !me && <p className="song-again__note">{t('scene.free', { n: trialUnits })}</p>}
        </section>
      )}

      {/* The terms record stays one click away for the owner, but as a quiet
          footnote: a full panel for it read as a warning stuck to every song. */}
      {manages && (
        <p className="song-page__terms">
          <Link to={`/tracks/${song.trackId}/license`} className="quiet-link">
            {t('song.usage')} ↗
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * "Write one too", for a person who was sent a song (docs/GROWTH_SPEC.md, part
 * two): a button, not a line of text, onto /create on the same occasion. A
 * signed-out reader is sent through sign-in by /create's own guard, with the
 * whole address kept.
 */
function WriteOneToo({ occasion }: { occasion: Occasion | null | undefined }) {
  const { t } = useI18n();
  return (
    <Link className="btn btn--primary" to={shareCreateHref(occasion)}>
      {t(occasion ? 'song.gift.again' : 'song.gift.again.plain')}
    </Link>
  );
}
