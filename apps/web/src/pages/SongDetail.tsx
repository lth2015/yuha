import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProductView, TrackView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { AmbientStage } from '../components/AmbientStage';
import { CoverArt } from '../components/CoverArt';
import { ErrorNotice } from '../components/common';
import { SyncedLyrics } from '../components/SyncedLyrics';

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
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { me } = useSession();
  const player = usePlayer();
  const [song, setSong] = useState<SongDetailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [licensePrice, setLicensePrice] = useState<number | null>(null);
  const [licensing, setLicensing] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    apiFetch<SongDetailResponse>(`/v1/tracks/${id}`)
      .then(setSong)
      .catch(setError);
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    apiFetch<ProductView[]>('/v1/products')
      .then((ps) => {
        const p = ps.find((x) => x.priceKey === 'market_license');
        if (p) setLicensePrice(p.amountMinor / 100);
      })
      .catch(() => undefined);
  }, []);

  if (error) {
    return (
      <div className="stack">
        <ErrorNotice error={error} />
        <Link to="/explore" className="btn">
          {t('song.backMarket')}
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
    player.play({ ...song, previewUrl: song.previewUrl });
  };

  const toggleLike = async () => {
    if (song.likedByMe === null) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ liked: boolean; likeCount: number }>(`/v1/explore/${song.trackId}/like`, {
        method: 'POST',
        body: { action: song.likedByMe ? 'unlike' : 'like' },
      });
      setSong({ ...song, likedByMe: res.liked, likeCount: res.likeCount });
    } finally {
      setBusy(false);
    }
  };

  const setVisibility = async (visibility: 'public' | 'private') => {
    setBusy(true);
    try {
      await apiFetch(`/v1/tracks/${song.trackId}/visibility`, { method: 'POST', body: { visibility } });
      setSong({ ...song, visibility });
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
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const buyLicense = async () => {
    if (licensing || !me) return;
    setLicensing(true);
    setError(null);
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
      setError(err);
    } finally {
      setLicensing(false);
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/song/${song.trackId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="song-page">
      <div className="song-spread">
        <div className="song-spread__stagewrap">
          <AmbientStage seed={song.coverSeed} className="song-spread__ambient" />
          <div className="song-spread__cover">
          <CoverArt
            seed={song.coverSeed}
            title={song.title}
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
            {song.artistName ?? t(isOwner ? 'song.you' : 'song.creator')} · {t('song.plays', { n: song.playCount.toLocaleString() })}
            {song.styles.length > 0 && <> · {song.styles.join(' / ')}</>}
          </p>

          <div className="song-spread__actions" aria-label="作品操作">
            <button
              type="button"
              className={`text-action${song.likedByMe ? ' is-liked' : ''}`}
              onClick={toggleLike}
              disabled={busy || song.likedByMe === null}
              aria-pressed={song.likedByMe ?? undefined}
            >
              {t('song.like', { n: song.likeCount })}
            </button>
            {song.visibility === 'public' && (
              <button type="button" className="text-action" onClick={share}>
                {copied ? t('song.copied') : t('song.share')}
              </button>
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
                  onClick={async () => {
                    if (!window.confirm(t('song.confirmDelete', { title: song.title }))) return;
                    await apiFetch(`/v1/tracks/${song.trackId}`, { method: 'DELETE' });
                    navigate('/library');
                  }}
                >
                  {t('song.delete')}
                </button>
              </>
            )}
            {!isOwner && song.visibility === 'public' && song.state === 'deliverable' && (
              song.licensedByMe ? (
                <button type="button" className="text-action" onClick={download} disabled={busy}>
                  {t('song.downloadLicensed')}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-action is-strong"
                  onClick={buyLicense}
                  disabled={licensing || !me || licensePrice === null}
                  title={me ? '购买使用授权，创作者获得 70%' : '登录后可购买授权'}
                >
                  {licensing ? t('song.licensing') : t('song.license', { price: licensePrice?.toFixed(2) ?? '' })}
                </button>
              )
            )}
          </div>

          {song.licenseCount > 0 && (
            <p className="song-spread__note">{t('song.licensesSold', { n: song.licenseCount })}</p>
          )}
          {song.demo && <p className="song-spread__note">{t('song.demo')}</p>}

          <div className="song-spread__player">
            <span className="song-spread__time num">
              {formatTime(active ? player.currentTime : 0)} / {formatTime(song.durationSeconds)}
            </span>
            <div
              className="song-spread__track"
              role="presentation"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                player.seek(((e.clientX - rect.left) / rect.width) * song.durationSeconds);
              }}
            >
              <span
                className="song-spread__fill"
                style={{ width: `${active && player.duration ? (player.currentTime / player.duration) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {song.lyrics && (
        <section className="song-page__lyrics panel" aria-labelledby="lyrics-heading">
          <h2 id="lyrics-heading">{t('song.lyrics')}</h2>
          <SyncedLyrics
            lyrics={song.lyrics}
            duration={player.duration || song.durationSeconds}
            currentTime={player.currentTime}
            timings={song.lyricTimings}
            onSeek={player.seek}
          />
        </section>
      )}

      <section className="song-page__license panel" aria-labelledby="license-heading">
        <h2 id="license-heading">{t('song.usage')}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {t('song.usageBody')}{' '}
          {isOwner && (
            <Link to={`/tracks/${song.trackId}/license`} className="linklike">
              {t('song.usageFull')}
            </Link>
          )}
        </p>
      </section>
    </div>
  );
}
