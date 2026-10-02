import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TrackView } from '@yuha/contracts';
import { attachBeat as attachBeatSafe, wakeBeat } from './beat';
import { creditHeard, hasHeardEnough, type Heard } from './listening';
import { createResignGuard, freshPreviewUrl } from './preview-url';

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
/**
 * What the player needs to carry a song around the app.
 *
 * `mood` is here for the sleeve's 温度 reading: the cover is drawn in the
 * player bar and the now-playing view as well as on the card, and a song that
 * read 72 in the library and 54 in the player bar would be worse than no
 * reading at all.
 */
export type PlayerTrack = Pick<
  TrackView,
  'trackId' | 'title' | 'artistName' | 'coverSeed' | 'styles' | 'durationSeconds' | 'vocalMode' | 'mood'
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
  /**
   * The playhead at frame rate, for anything that has to land on a beat.
   *
   * `currentTime` on this object comes from the audio element's `timeupdate`
   * event, which fires about four times a second. That is fine for a progress
   * bar and much too coarse for karaoke: a line could not light up until as
   * much as 250ms after it was sung, every line, which reads as the lyrics
   * running late — and the fill crawled in four steps a second instead of
   * moving. Subscribers here are driven by requestAnimationFrame and read the
   * element directly, so nothing in the React tree re-renders for them.
   */
  onTime(handler: (seconds: number) => void): () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resign = useRef(createResignGuard());
  const listeners = useRef(new Set<(id: string) => void>());
  const timeListeners = useRef(new Set<(seconds: number) => void>());
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
    // A new attempt gets a fresh chance: pressing play on the same song an
    // hour later will meet an expired signature all over again.
    resign.current.armFor(track.trackId);
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
    /*
     * A failed load is usually an expired signature, not a broken song.
     *
     * `previewUrl` is signed when the track was fetched and lasts five
     * minutes; a library left open longer than that has a row of play buttons
     * that each do nothing and say nothing. Ask the server to sign it again,
     * once, and play it. `createResignGuard` is what keeps "once" true —
     * `error` fires for genuinely broken audio too, and a retry that re-armed
     * itself would turn one dead file into a request loop.
     *
     * `audio.dataset.trackId` rather than React state: this listener is bound
     * once, so a captured `activeId` would be the one from the first render.
     */
    const onError = () => {
      const trackId = audio.dataset['trackId'] ?? null;
      if (!resign.current.mayRetry(trackId)) {
        setState((s) => ({ ...s, status: 'error' }));
        return;
      }
      setState((s) => ({ ...s, status: 'loading' }));
      void freshPreviewUrl(trackId!).then((url) => {
        // The listener may have raced a different song into the element while
        // the request was out; writing a stale url here would stop that one.
        if (!url || audio.dataset['trackId'] !== trackId) {
          setState((s) => ({ ...s, status: 'error' }));
          return;
        }
        audio.src = url;
        void audio.play().catch(() => setState((s) => ({ ...s, status: 'error' })));
      });
    };

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

  const onTime = useCallback((handler: (seconds: number) => void) => {
    timeListeners.current.add(handler);
    return () => timeListeners.current.delete(handler);
  }, []);

  /*
   * One rAF loop for every time subscriber, running only while audio is
   * playing. It reads `audio.currentTime` straight off the element rather
   * than any React state, so a subscriber sees the real playhead with at most
   * one frame of delay and the provider never re-renders on its account.
   */
  useEffect(() => {
    if (state.status !== 'playing') return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const audio = audioRef.current;
      if (!audio) return;
      for (const l of timeListeners.current) l(audio.currentTime);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.status]);

  const api = useMemo<PlayerApi>(
    () => ({ ...state, current, queue, play, toggle, seek, next, prev, stop, onTenSeconds, onTime }),
    [state, current, queue, play, toggle, seek, next, prev, stop, onTenSeconds, onTime],
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
