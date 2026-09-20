import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProductView, TrackView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
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
          回到市场
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
            aria-label={playing ? `暂停「${song.title}」` : `播放「${song.title}」`}
          >
            <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
            {playing ? '暂停' : '试听'}
          </button>
        </div>

        <div className="song-spread__info">
          <p className="eyebrow song-spread__eyebrow">
            {song.visibility === 'public' ? '市场在架' : isOwner ? '私人收藏' : '作品'} ·{' '}
            {song.vocalMode === 'instrumental' ? '纯音乐' : '有人声'} · {formatTime(song.durationSeconds)}
          </p>
          <h1 className="song-spread__title">{song.title}</h1>
          <p className="song-spread__meta">
            {song.artistName ?? (isOwner ? '你' : '一位创作者')} · {song.playCount.toLocaleString()} 次播放
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
              ♡ {song.likeCount}
            </button>
            {song.visibility === 'public' && (
              <button type="button" className="text-action" onClick={share}>
                {copied ? '已复制链接' : '分享 ↗'}
              </button>
            )}
            {isOwner && (
              <>
                <Link className="text-action" to={`/create?edit=${song.trackId}`}>
                  AI 再创作 ↗
                </Link>
                <button type="button" className="text-action" onClick={download} disabled={busy}>
                  下载 MP3 ↓
                </button>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setVisibility(song.visibility === 'public' ? 'private' : 'public')}
                  disabled={busy}
                >
                  {song.visibility === 'public' ? '取消发布' : '发布到市场 ↗'}
                </button>
                <button
                  type="button"
                  className="text-action is-danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`删除「${song.title}」？此操作不可撤销。`)) return;
                    await apiFetch(`/v1/tracks/${song.trackId}`, { method: 'DELETE' });
                    navigate('/library');
                  }}
                >
                  删除
                </button>
              </>
            )}
            {!isOwner && song.visibility === 'public' && song.state === 'deliverable' && (
              song.licensedByMe ? (
                <button type="button" className="text-action" onClick={download} disabled={busy}>
                  下载已授权 MP3 ↓
                </button>
              ) : (
                <button
                  type="button"
                  className="text-action is-strong"
                  onClick={buyLicense}
                  disabled={licensing || !me || licensePrice === null}
                  title={me ? '购买使用授权，创作者获得 70%' : '登录后可购买授权'}
                >
                  {licensing ? '正在打开支付…' : `购买授权 · $${licensePrice?.toFixed(2)} ↗`}
                </button>
              )
            )}
          </div>

          {song.licenseCount > 0 && (
            <p className="song-spread__note">已在市场售出 {song.licenseCount} 份授权</p>
          )}
          {song.demo && <p className="song-spread__note">演示环境：音频为合成示例。</p>}

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
          <h2 id="lyrics-heading">歌词</h2>
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
        <h2 id="license-heading">使用条件</h2>
        <p className="small muted" style={{ margin: 0 }}>
          每首作品都记录着生成当时适用的使用条件。{' '}
          {isOwner && (
            <Link to={`/tracks/${song.trackId}/license`} className="linklike">
              查看完整记录
            </Link>
          )}
        </p>
      </section>
    </div>
  );
}
