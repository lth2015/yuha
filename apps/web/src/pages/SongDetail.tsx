import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { CoverArt } from '../components/CoverArt';
import { ErrorNotice } from '../components/common';

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
 * Song detail: big cover, transport, lyrics, license note, and — for the
 * owner — download/publish controls. Public songs are readable anonymously;
 * private ones only by their creator (the server decides, not this page).
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

  const load = useCallback(() => {
    if (!id) return;
    apiFetch<SongDetailResponse>(`/v1/tracks/${id}`)
      .then(setSong)
      .catch(setError);
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <div className="stack">
        <ErrorNotice error={error} />
        <Link to="/explore" className="btn">
          Back to Explore
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
    // Full-length export at native quality; trimming is available from the
    // library menu when needed. Re-downloads are free (UI-06 heritage).
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
      <div className="song-page__hero panel">
        <CoverArt seed={song.coverSeed} title={song.title} size={280} className="song-page__art" playing={playing} />
        <div className="song-page__info">
          <p className="song-page__eyebrow">
            {song.visibility === 'public' ? 'Public' : isOwner ? 'Private' : 'Song'}
          </p>
          <h1>{song.title}</h1>
          <p className="song-page__meta">
            by <strong>{song.artistName ?? (isOwner ? 'you' : 'a creator')}</strong> ·{' '}
            {formatTime(song.durationSeconds)} · {song.vocalMode === 'instrumental' ? 'Instrumental' : 'Vocals'} ·{' '}
            {song.playCount.toLocaleString()} plays
          </p>
          {song.styles.length > 0 && (
            <div className="chips">
              {song.styles.map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
            </div>
          )}
          <div className="song-page__actions">
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={play}
              disabled={!song.previewUrl}
            >
              <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className={`btn like-btn${song.likedByMe ? ' like-btn--on' : ''}`}
              onClick={toggleLike}
              disabled={busy || song.likedByMe === null}
              aria-pressed={song.likedByMe ?? undefined}
            >
              <span className="icon icon--heart" aria-hidden="true" /> {song.likeCount}
            </button>
            {song.visibility === 'public' && (
              <button type="button" className="btn" onClick={share}>
                {copied ? 'Link copied' : 'Share'}
              </button>
            )}
            {isOwner && (
              <>
                <button type="button" className="btn" onClick={download} disabled={busy}>
                  Download MP3
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setVisibility(song.visibility === 'public' ? 'private' : 'public')}
                  disabled={busy}
                >
                  {song.visibility === 'public' ? 'Unpublish' : 'Publish'}
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`Delete “${song.title}”? This cannot be undone.`)) return;
                    await apiFetch(`/v1/tracks/${song.trackId}`, { method: 'DELETE' });
                    navigate('/library');
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>

        </div>
      </div>

      {song.lyrics && (
        <section className="panel song-page__lyrics" aria-labelledby="lyrics-heading">
          <h2 id="lyrics-heading">Lyrics</h2>
          <pre className="lyrics">{song.lyrics}</pre>
        </section>
      )}

      <section className="panel song-page__license" aria-labelledby="license-heading">
        <h2 id="license-heading">Usage record</h2>
        <p className="small muted">
          Every song carries the usage terms that were in force when it was generated.{' '}
          {isOwner && (
            <Link to={`/tracks/${song.trackId}/license`} className="linklike">
              View the full record
            </Link>
          )}
        </p>
      </section>
    </div>
  );
}
