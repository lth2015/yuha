import { useEffect, useRef } from 'react';
import type { LyricTimings, TrackView } from '@yuha/contracts';
import { apiFetch } from './api';

/**
 * Taking an automatic lyric sync onto every view of a song while it is open
 * (docs/agents/LYRIC_AUTO_SYNC_UX_HANDOFF.md): the song page and the
 * full-screen Now Playing lyrics.
 *
 * While a song is `syncing`, ask for it every 12 s — only while the page is
 * in front, and once more when it comes back. A late answer for a song that
 * is no longer this view's is dropped. What comes back is only the timeline
 * and its state: the player is never touched, so the music keeps playing and
 * the highlight picks up where it is. Whichever view hears first tells the
 * others (one current timeline for all of them, Codex review of PR #157).
 */
export interface LyricSyncUpdate {
  trackId: string;
  lyricSync: TrackView['lyricSync'];
  lyricTimings: LyricTimings | null;
}

const EVENT = 'yuha:lyric-sync';
export const LYRIC_SYNC_POLL_MS = 12_000;

export interface RefreshEnv {
  fetchTrack: (trackId: string) => Promise<LyricSyncUpdate>;
  isVisible: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  onVisible: (fn: () => void) => () => void;
  broadcast: (update: LyricSyncUpdate) => void;
}

/** The loop itself, free of React and the DOM so it can be tested with a fake clock. Returns stop(). */
export function startLyricSyncRefresh(trackId: string, apply: (u: LyricSyncUpdate) => void, env: RefreshEnv): () => void {
  let stopped = false;
  const ask = () => {
    if (stopped || !env.isVisible()) return;
    env
      .fetchTrack(trackId)
      .then((fresh) => {
        // Stopped (another song, the view closed, or the sync landed elsewhere): this answer is not for us.
        if (stopped || fresh.trackId !== trackId) return;
        apply(fresh);
        env.broadcast(fresh);
      })
      .catch(() => undefined);
  };
  const timer = env.setInterval(ask, LYRIC_SYNC_POLL_MS);
  const offVisible = env.onVisible(ask);
  return () => {
    stopped = true;
    env.clearInterval(timer);
    offVisible();
  };
}

export function publishLyricSyncUpdate(detail: LyricSyncUpdate): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

const browserEnv = (): RefreshEnv => ({
  fetchTrack: async (id) => {
    const t = await apiFetch<TrackView>(`/v1/tracks/${id}`);
    return { trackId: t.trackId, lyricSync: t.lyricSync, lyricTimings: t.lyricTimings };
  },
  isVisible: () => document.visibilityState === 'visible',
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (h) => window.clearInterval(h as number),
  onVisible: (fn) => {
    const on = () => fn();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  },
  broadcast: publishLyricSyncUpdate,
});

/**
 * One view of a song: polls while it is syncing, and takes any update another
 * view of the same song heard. `apply` should replace only the lyric fields.
 */
export function useLyricSyncRefresh(trackId: string | null | undefined, syncing: boolean, apply: (u: LyricSyncUpdate) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!trackId) return undefined;
    const heard = (e: Event) => {
      const u = (e as CustomEvent<LyricSyncUpdate>).detail;
      if (u?.trackId === trackId) applyRef.current(u);
    };
    window.addEventListener(EVENT, heard);
    return () => window.removeEventListener(EVENT, heard);
  }, [trackId]);
  useEffect(() => {
    if (!trackId || !syncing) return undefined;
    return startLyricSyncRefresh(trackId, (u) => applyRef.current(u), browserEnv());
  }, [trackId, syncing]);
}
