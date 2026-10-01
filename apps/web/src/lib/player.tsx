import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TrackView } from '@yuha/contracts';
import { attachBeat as attachBeatSafe, wakeBeat } from './beat';
import { creditHeard, hasHeardEnough, type Heard } from './listening';

/**
 * A single shared <audio> element with a queue.
 *
 * Only one song ever plays at a time: there is exactly one audio element for
 * the whole app, so starting a new song inherently stops the previous one
 * (UI-01/UI-05 heritage). Playback never autoplays (UI-14) — it starts from a
 * user gesture and continues through the queue as songs end.
 */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** What the player bar needs to render: view fields + where it can link to. */
export type PlayerTrack = Pick<
  TrackView,
  'trackId' | 'title' | 'artistName' | 'coverSeed' | 'styles' | 'durationSeconds' | 'vocalMode'
>;

interface PlayerState {
  /** Identifies what is loaded, so each card knows whether it is the active one. */
  activeId: string | null;
  status: PlayerStatus;
  currentTime: number;
  duration: number;
}

interface PlayerApi extends PlayerState {
  current: PlayerTrack | null;
  queue: PlayerTrack[];
  /** Plays one song now, optionally setting the surrounding queue context. */
  play(track: PlayerTrack & { previewUrl: string | null }, queue?: PlayerTrack[]): void;
  toggle(): void;
  seek(seconds: number): void;
  next(): void;
  prev(): void;
  stop(): void;
  /** Fires once per song when 10s of audio has actually been heard (§11.1). */
  onTenSeconds(handler: (id: string) => void): () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listeners = useRef(new Set<(id: string) => void>());
  const reported = useRef(new Set<string>());
  /** Seconds of this song really heard; the rule is in lib/listening.ts. */
  const heard = useRef<Heard>({ id: null, seconds: 0, last: 0 });
  const queueRef = useRef<PlayerTrack[]>([]);
  const [current, setCurrent] = useState<PlayerTrack | null>(null);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [state, setState] = useState<PlayerState>({
    activeId: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
  });

  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'metadata';
    // Tap the analyser once so ambient visuals can read the real rhythm.
    attachBeatSafe(audioRef.current);
  }

  const startTrack = useCallback((track: PlayerTrack & { previewUrl: string | null }) => {
    const audio = audioRef.current;
    if (!audio || !track.previewUrl) return;
    audio.pause();
    audio.src = track.previewUrl;
    audio.dataset['trackId'] = track.trackId;
    audio.currentTime = 0;
    // Replaying the same song starts its ten seconds over; `reported` is what
    // keeps the event itself to once per page load.
    heard.current = { id: track.trackId, seconds: 0, last: 0 };
    setCurrent(track);
    setState({ activeId: track.trackId, status: 'loading', currentTime: 0, duration: 0 });
    // The analyser graph carries the audio (createMediaElementSource
    // reroutes the element), so a suspended context is silence, not just
    // still visuals. This is the user gesture; resume here or never.
    wakeBeat();
    void audio.play().catch(() => setState((s) => ({ ...s, status: 'error' })));
  }, []);

  const play = useCallback(
    (track: PlayerTrack & { previewUrl: string | null }, nextQueue?: PlayerTrack[]) => {
      if (nextQueue) {
        queueRef.current = nextQueue;
        setQueue(nextQueue);
      }
      startTrack(track);
    },
    [startTrack],
  );

  const next = useCallback(() => {
    const list = queueRef.current;
    const idx = list.findIndex((t) => t.trackId === state.activeId);
    for (let i = idx + 1; i < list.length; i++) {
      const t = list[i]!;
      // Cards in a queue carry a previewUrl only when rendered from a feed;
      // the bar refetches nothing — it skips songs without a URL.
      if ('previewUrl' in t && (t as { previewUrl?: string }).previewUrl) {
        startTrack(t as PlayerTrack & { previewUrl: string });
        return;
      }
    }
  }, [state.activeId, startTrack]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const list = queueRef.current;
    const idx = list.findIndex((t) => t.trackId === state.activeId);
    for (let i = idx - 1; i >= 0; i--) {
      const t = list[i]!;
      if ('previewUrl' in t && (t as { previewUrl?: string }).previewUrl) {
        startTrack(t as PlayerTrack & { previewUrl: string });
        return;
      }
    }
  }, [state.activeId, startTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      setState((s) => ({ ...s, currentTime: audio.currentTime }));

      const id = audio.dataset['trackId'];
      if (!id) return;
      heard.current = creditHeard(heard.current, id, audio.currentTime);

      if (hasHeardEnough(heard.current) && !reported.current.has(id)) {
        reported.current.add(id);
        for (const l of listeners.current) l(id);
      }
    };
    const onLoaded = () => setState((s) => ({ ...s, duration: audio.duration || 0 }));
    const onPlay = () => setState((s) => ({ ...s, status: 'playing' }));
    // 'playing' (not 'play') is the "buffering ended" signal — without it the
    // bar would stay on "buffering…" forever after a mid-stream stall.
    const onPlaying = () => setState((s) => ({ ...s, status: 'playing' }));
    const onPause = () => setState((s) => (s.status === 'playing' ? { ...s, status: 'paused' } : s));
    const onEnded = () => {
      setState((s) => ({ ...s, status: 'paused', currentTime: 0 }));
      nextRef.current?.();
    };
    const onWaiting = () => setState((s) => ({ ...s, status: 'loading' }));
    const onError = () => setState((s) => ({ ...s, status: 'error' }));

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('error', onError);
      audio.pause();
    };
  }, []);

  // `next` is recreated as activeId changes; keep a stable ref for onEnded.
  const nextRef = useRef<() => void>(next);
  nextRef.current = next;

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      wakeBeat();
      void audio.play().catch(() => setState((s) => ({ ...s, status: 'error' })));
    } else {
      audio.pause();
    }
  }, [current]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || Number.isNaN(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
  }, []);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setCurrent(null);
    setState({ activeId: null, status: 'idle', currentTime: 0, duration: 0 });
  }, []);

  const onTenSeconds = useCallback((handler: (id: string) => void) => {
    listeners.current.add(handler);
    return () => listeners.current.delete(handler);
  }, []);

  const api = useMemo<PlayerApi>(
    () => ({ ...state, current, queue, play, toggle, seek, next, prev, stop, onTenSeconds }),
    [state, current, queue, play, toggle, seek, next, prev, stop, onTenSeconds],
  );

  return <PlayerContext.Provider value={api}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside a PlayerProvider');
  return ctx;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
