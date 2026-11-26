import { useEffect, useMemo, useRef, useState } from 'react';
import { markCorrected, setLineStart, shiftTimings, type LyricTimings } from '@yuha/contracts';
import { ApiError, apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { activeLineIndex, resolveLyricTimings } from '../lib/lyrics';
import { formatTime, usePlayer } from '../lib/player';
import { lineRange, loopRange, moveLine } from '../lib/sync-studio';
import { ErrorNotice } from './common';
import { useSession } from '../lib/session';

/**
 * Lining the lyrics up, inside the video card (docs/MV_LYRIC_SYNC_UX_SPEC.md,
 * phase 1). Everything needed to judge one line is on one screen: the words,
 * play, a timeline with the song's loudness and where each line sits, and a
 * small preview of what the video will show at this moment.
 *
 * One clock: the page's player, the same one the lyrics below follow. One set
 * of edits: SongDetail holds the unsaved draft and its undo, so a line moved
 * here is moved in the lyrics area too, and Save in either saves both.
 *
 * Nothing here re-makes the song or the video. A nudge changes numbers on this
 * page at once; Save writes them; the next video made uses them.
 */
/** Pixels per second of song in the lane at least, at most before zooming, and the zoom's factor. */
const PX_NORMAL = 36;
const PX_MAX_BASE = 90;
const ZOOM = 2.5;
/** The height a line needs for one row of words. */
const ROW_PX = 22;
/** Room above the first second and below the last, so neither sits on the lane's edge. */
const LANE_PAD = 12;
/** A time mark every this many seconds. */
const TICK_SECONDS = 5;
/** The tallest canvas drawn, in device pixels (iOS Safari refuses much larger). */
const MAX_CANVAS_PX = 16_000;
const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
};

export function LyricSyncStudio({
  trackId,
  lyrics,
  savedTimings,
  duration,
  draft,
  onDraft,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSave,
  active,
  onPlay,
  photos,
}: {
  trackId: string;
  lyrics: string;
  savedTimings: LyricTimings | null | undefined;
  duration: number;
  /** The unsaved edit, null when what is shown is what is saved. */
  draft: LyricTimings | null;
  onDraft: (next: LyricTimings | null) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onSave: (timings: LyricTimings) => Promise<void>;
  /** The player is on this song. */
  active: boolean;
  /** Start this song in the player. */
  onPlay: () => void;
  /** Thumbnails of the photos chosen, for the preview; none means the cover video. */
  photos: string[];
}) {
  const { t } = useI18n();
  const player = usePlayer();
  const { runtime } = useSession();

  /*
   * "Align it again" (services/lyric-proposal.ts): the aligner asked with the
   * song's own audio, its answer loaded here as an unsaved edit to listen to
   * before keeping. Free; offered only where a real aligner is configured.
   * Only an answer this view watched arrive is loaded — a proposal from an
   * earlier visit is not dropped onto the timeline unasked.
   */
  type Auto = { status: 'queued' | 'running' | 'ready' | 'held' | 'failed' | 'none' | 'limit'; ahead?: number; failure?: string; timings?: LyricTimings };
  const [auto, setAuto] = useState<Auto | null>(null);
  const watching = useRef(false);
  /** The edit in hand when an answer lands: an answer never replaces it unasked. */
  const draftNow = useRef(draft);
  draftNow.current = draft;
  useEffect(() => {
    if (!runtime?.features.lyricAutoAlign) return;
    let live = true;
    let timer: number | undefined;
    let misses = 0;
    const poll = async () => {
      const a = await apiFetch<Auto>(`/v1/tracks/${trackId}/lyric-proposal`).catch(() => null);
      if (!live) return;
      // A blip on a phone's connection is not the end of the wait: try again, more slowly.
      if (!a) {
        if (watching.current) timer = window.setTimeout(() => void poll(), Math.min(30_000, 3000 * 2 ** Math.min(4, ++misses)));
        return;
      }
      misses = 0;
      if (a.status === 'queued' || a.status === 'running') {
        watching.current = true;
        setAuto(a);
        timer = window.setTimeout(() => void poll(), 3000);
        return;
      }
      if (watching.current) {
        watching.current = false;
        // Edits made while it worked stay; the answer waits behind a button.
        if (a.status === 'ready' && a.timings && draftNow.current) return setAuto({ ...a, status: 'held' });
        setAuto(a);
        if (a.status === 'ready' && a.timings) onDraft(a.timings);
      }
    };
    if (auto?.status === 'queued' || auto?.status === 'running' || auto === null) void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trackId, runtime?.features.lyricAutoAlign, auto?.status === 'queued' || auto?.status === 'running']);
  const alignAgain = async () => {
    try {
      const a = await apiFetch<Auto>(`/v1/tracks/${trackId}/lyric-proposal`, { method: 'POST' });
      watching.current = true;
      setAuto(a);
    } catch (err) {
      setAuto({ status: err instanceof ApiError && err.status === 429 ? 'limit' : 'failed', failure: 'error' });
    }
  };
  const saved = useMemo(() => resolveLyricTimings(lyrics, duration, savedTimings), [lyrics, duration, savedTimings]);
  /** While a block is being dragged: shown at once, recorded once on release. */
  const [dragging, setDragging] = useState<LyricTimings | null>(null);
  const shown = dragging ?? draft ?? saved;
  const lines = shown.lines;

  // The playhead at frame rate while this song plays (as SyncedLyrics does).
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    setNow(player.currentTime);
    return player.onTime(setNow);
  }, [player, active]);
  const playing = active && player.status === 'playing';
  const current = activeLineIndex(lines, now);

  const [selected, setSelected] = useState(0);
  const sel = lines[selected] ? selected : 0;
  const line = lines[sel];

  /*
   * A seek asked for before the song is in the player waits for it: the audio
   * element ignores currentTime until it knows the duration.
   */
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    if (active && player.duration > 0 && pendingSeek.current != null) {
      player.seek(pendingSeek.current);
      pendingSeek.current = null;
    }
  }, [active, player.duration, player]);
  const seek = (seconds: number) => {
    setNow(seconds);
    if (active && player.duration > 0) {
      player.seek(seconds);
      if (player.status !== 'playing') player.toggle();
    } else {
      pendingSeek.current = seconds;
      onPlay();
    }
  };

  // "Listen to this line": round and round until stopped or another line is chosen.
  const [loop, setLoop] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (!loop || !active) return;
    return player.onTime((s) => {
      if (s >= loop.to || loop.from - 0.5 > s) player.seek(loop.from);
    });
  }, [loop, active, player]);
  const listen = () => {
    if (loop) return setLoop(null);
    const range = loopRange(lines, sel, duration);
    setLoop(range);
    seek(range.from);
  };
  useEffect(() => setLoop(null), [sel]);

  /*
   * The lane: time runs down the page, so on a phone each line's words sit
   * beside its time at full width instead of squeezed into a sideways strip
   * (product owner, 2026-11-26). `pxPerSecond` is the whole layout.
   */
  const [zoomed, setZoomed] = useState(false);
  /*
   * Enough pixels a second that the shortest line still has a row of words
   * and a finger's worth of height: at a fixed scale a 0.4 s line was a
   * wordless sliver nobody could pick. The zoom multiplies from there.
   */
  const shortest = Math.max(0.3, Math.min(...lines.map((l, i) => Math.min(l.end, lines[i + 1]?.start ?? l.end) - l.start).filter((d) => d > 0), 99));
  const base = Math.min(PX_MAX_BASE, Math.max(PX_NORMAL, ROW_PX / shortest));
  const pxPerSecond = zoomed ? base * ZOOM : base;
  const laneHeight = Math.ceil(duration * pxPerSecond) + LANE_PAD * 2;
  const y = (seconds: number) => LANE_PAD + seconds * pxPerSecond;

  // The song's loudness (GET /v1/tracks/:id/waveform). A picture only; failing to get it changes nothing else.
  const [wave, setWave] = useState<{ peaks: number[]; seconds: number } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    // The server draws two at a time and says when to come back; a busy moment is not a failure.
    const get = (tries: number) =>
      apiFetch<{ peaks: number[]; seconds: number }>(`/v1/tracks/${trackId}/waveform`)
        .then((w) => live && setWave(w))
        .catch((err) => {
          if (!live) return;
          if (err instanceof ApiError && err.status === 429 && tries < 3) timer = window.setTimeout(() => get(tries + 1), 5000);
          else setWave('failed');
        });
    void get(0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trackId]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !wave || wave === 'failed') return;
    // A whole song at the fine zoom is tall: keep the canvas under what
    // iOS Safari will allocate, trading a little sharpness for drawing at all.
    const scale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / Math.max(1, laneHeight));
    const w = (c.width = Math.round(c.clientWidth * scale));
    const h = (c.height = Math.round(laneHeight * scale));
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).color;
    const perSecond = wave.peaks.length / Math.max(0.1, wave.seconds);
    const step = Math.max(1, Math.round(2 * scale));
    for (let py = 0; py < h; py += step) {
      const s = (py / scale - LANE_PAD) / pxPerSecond;
      const p = s < 0 ? 0 : (wave.peaks[Math.floor(s * perSecond)] ?? 0);
      const bar = Math.max(1, p * w * 0.9);
      g.fillRect((w - bar) / 2, py, bar, Math.max(1, step * 0.75));
    }
  }, [wave, laneHeight, pxPerSecond]);

  /*
   * The lane follows the playhead while the song plays, a third of the way
   * down, unless the person has just scrolled it themselves: then it waits,
   * so it never yanks away the line they went looking for.
   */
  const lane = useRef<HTMLDivElement>(null);
  const handsOnUntil = useRef(0);
  /** Where this component last scrolled the lane to: any other scroll is the person's. */
  const ourScroll = useRef<number | null>(null);
  const handsOn = () => {
    handsOnUntil.current = Date.now() + 4000;
  };
  const scrollLane = (top: number) => {
    const el = lane.current;
    if (!el) return;
    ourScroll.current = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    el.scrollTo({ top: ourScroll.current });
  };
  useEffect(() => {
    const el = lane.current;
    if (!el || !playing || Date.now() < handsOnUntil.current || drag.current) return;
    const target = y(now) - el.clientHeight / 3;
    if (Math.abs(el.scrollTop - target) > el.clientHeight / 4) scrollLane(target);
  }, [now, playing]);
  // A zoom change keeps the chosen line in view.
  useEffect(() => {
    const el = lane.current;
    const l = lines[sel];
    if (!el || !l) return;
    const top = y(l.start);
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 40) scrollLane(top - el.clientHeight / 3);
  }, [zoomed]);
  /*
   * A tap on the lane plays from there; a touch that scrolls it does not.
   * Seeking on pointerdown started the song every time a finger landed to
   * scroll, so the decision waits for the click, which a scroll cancels,
   * and checks the pointer barely moved.
   */
  const press = useRef<{ x: number; y: number; top: number } | null>(null);

  // Dragging the chosen line's block moves its start; one undo step per drag.
  const drag = useRef<{ y: number; base: LyricTimings; start: number } | null>(null);
  /** Touch drags start on the grip, so the rest of a tall chosen block still scrolls the lane. */
  const grabs = (e: React.PointerEvent) => e.pointerType === 'mouse' || !!(e.target as HTMLElement).closest('.sync-studio__grip');
  const timeAt = (clientY: number) => {
    const box = lane.current!.getBoundingClientRect();
    return (clientY - box.top + lane.current!.scrollTop - LANE_PAD) / pxPerSecond;
  };
  const ticks = Array.from({ length: Math.floor(duration / TICK_SECONDS) + 1 }, (_, i) => i * TICK_SECONDS);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  // Nothing moves while a save is out: an edit made then would be cleared by its answer.
  const commit = (next: LyricTimings) => {
    if (!saving) onDraft(next);
  };
  const nudgeLine = (delta: number) => commit(moveLine(draft ?? saved, sel, delta, duration));
  const nudgeAll = (delta: number) => commit(shiftTimings(draft ?? saved, delta, duration));
  const stamp = () => commit(setLineStart(draft ?? saved, sel, now, duration));

  const [justSaved, setJustSaved] = useState(false);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(markCorrected(draft));
      setJustSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (draft) setJustSaved(false);
  }, [draft]);

  const range = line ? lineRange(lines, sel, duration) : null;
  const shownLine = lines[current];
  const photo = photos.length ? photos[Math.min(photos.length - 1, Math.floor((now / Math.max(1, duration)) * photos.length))] : null;

  return (
    <div className="sync-studio" role="group" aria-label={t('sync.title')}>
      <p className="sync-studio__lead">{t('sync.lead')}</p>
      {runtime?.features.lyricAutoAlign && (
        <div className="sync-studio__auto">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void alignAgain()}
            disabled={!!draft || auto?.status === 'queued' || auto?.status === 'running'}
            aria-busy={auto?.status === 'queued' || auto?.status === 'running'}
          >
            {t('sync.auto.button')}
          </button>
          {auto?.status === 'held' && auto.timings && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                onDraft(auto.timings!);
                setAuto({ status: 'ready' });
              }}
            >
              {t('sync.auto.load')}
            </button>
          )}
          <p className="small muted" aria-live="polite">
            {auto?.status === 'held'
              ? t('sync.auto.held')
              : draft && !auto
              ? t('sync.auto.saveFirst')
              : auto?.status === 'queued'
                ? t('sync.auto.queued', { n: auto.ahead ?? 0 })
                : auto?.status === 'running'
                  ? t('sync.auto.running')
                  : auto?.status === 'ready'
                    ? t('sync.auto.ready')
                    : auto?.status === 'limit'
                      ? t('sync.auto.limit')
                      : auto?.status === 'failed'
                        ? t(auto.failure === 'low_coverage' ? 'sync.auto.failed.coverage' : 'sync.auto.failed.other')
                        : t('sync.auto.note')}
          </p>
        </div>
      )}
      <div className="sync-studio__top">
        <div
          className={`sync-studio__preview${photo ? '' : ' is-cover'}`}
          style={photo ? { backgroundImage: `url(${photo})` } : undefined}
          aria-label={t('sync.preview')}
          role="img"
        >
          <span className="sync-studio__preview-line">{shownLine && now >= shownLine.start ? shownLine.text : ''}</span>
        </div>
        <div className="sync-studio__transport">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => (active ? player.toggle() : onPlay())}>
            {t(playing ? 'sync.pause' : 'sync.play')}
          </button>
          <span className="num sync-studio__clock">
            {fmt(now)} / {fmt(duration)}
          </span>
          <span className={`lyrics-sync__pill${shown.source === 'estimated' ? '' : ' is-aligned'}`}>
            {t(shown.source === 'corrected' ? 'lyrics.corrected' : shown.source === 'aligned' ? 'lyrics.aligned' : 'lyrics.estimated')}
          </span>
          <button type="button" className="chip chip--btn" aria-pressed={zoomed} onClick={() => setZoomed((z) => !z)}>
            {t(zoomed ? 'sync.zoomOut' : 'sync.zoomIn')}
          </button>
        </div>
      </div>

      <div
        ref={lane}
        className="sync-studio__lane"
        aria-label={t('sync.timeline')}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          if (ourScroll.current !== null && Math.abs(top - ourScroll.current) < 2) return;
          ourScroll.current = null;
          handsOn();
        }}
      >
        <div
          className="sync-studio__track"
          style={{ height: laneHeight }}
          onPointerDown={(e) => {
            press.current = { x: e.clientX, y: e.clientY, top: lane.current?.scrollTop ?? 0 };
          }}
          onClick={(e) => {
            const pr = press.current;
            press.current = null;
            if ((e.target as HTMLElement).closest('.sync-studio__block')) return;
            if (!pr || Math.abs(e.clientX - pr.x) > 8 || Math.abs(e.clientY - pr.y) > 8 || Math.abs((lane.current?.scrollTop ?? 0) - pr.top) > 2) return;
            // Going somewhere else ends the loop; otherwise it would pull straight back.
            setLoop(null);
            handsOn();
            seek(Math.max(0, Math.min(duration, timeAt(e.clientY))));
          }}
        >
          <canvas ref={canvas} className="sync-studio__wave" style={{ height: laneHeight }} aria-hidden="true" />
          {ticks.map((s) => (
            <span key={s} className="sync-studio__tick num" style={{ top: y(s) }} aria-hidden="true">
              {formatTime(s)}
            </span>
          ))}
          {lines.map((l, i) => {
            const end = Math.min(l.end, lines[i + 1]?.start ?? l.end);
            const height = Math.max(4, (end - l.start) * pxPerSecond - 2);
            return (
              <button
                key={i}
                type="button"
                className={`sync-studio__block${i === sel ? ' is-selected' : ''}${i === current ? ' is-current' : ''}`}
                style={{ top: y(l.start), height }}
                aria-label={`${i + 1}. ${l.text} ${fmt(l.start)}`}
                aria-pressed={i === sel}
                onClick={() => setSelected(i)}
                onPointerDown={(e) => {
                  if (i !== sel || saving || !grabs(e)) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { y: e.clientY, base: draft ?? saved, start: l.start };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const seconds = (e.clientY - d.y) / pxPerSecond;
                  if (Math.abs(seconds) < 0.02) return;
                  setDragging(setLineStart(d.base, sel, d.start + seconds, duration));
                }}
                onPointerUp={() => {
                  drag.current = null;
                  if (dragging) commit(dragging);
                  setDragging(null);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setDragging(null);
                }}
              >
                {/* One row, cut with an ellipsis, when the line is short; it
                    wraps when there is room. The chosen line is written out
                    in full below either way. */}
                <span className={`sync-studio__label${height < ROW_PX * 2 ? ' is-short' : ''}`}>
                  {i === sel && (
                    <span className="sync-studio__grip" aria-hidden="true">
                      ⇅
                    </span>
                  )}
                  <span className="num sync-studio__at">{fmt(l.start)}</span> {l.text}
                </span>
              </button>
            );
          })}
          {active && <span className="sync-studio__cursor" style={{ top: y(now) }} aria-hidden="true" />}
        </div>
      </div>

      {line && range && (
        <fieldset className="sync-studio__fix">
          <legend>
            {t('sync.line', { n: sel + 1 })} · <span className="num">{fmt(line.start)}</span>
          </legend>
          <p className="sync-studio__quote">{line.text}</p>
          <div className="sync-studio__row">
            <button type="button" className="btn btn--sm" onClick={() => nudgeLine(0.1)} disabled={saving || line.start >= range.max}>
              {t('sync.tooEarly', { s: '0.1' })}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => nudgeLine(-0.1)} disabled={saving || line.start <= range.min}>
              {t('sync.tooLate', { s: '0.1' })}
            </button>
          </div>
          <div className="sync-studio__row">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeLine(0.5)} disabled={saving || line.start >= range.max}>
              {t('sync.later', { s: '0.5' })}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeLine(-0.5)} disabled={saving || line.start <= range.min}>
              {t('sync.earlier', { s: '0.5' })}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" aria-pressed={loop !== null} onClick={listen}>
              {t(loop ? 'sync.listen.stop' : 'sync.listen')}
            </button>
            {playing && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={stamp} disabled={saving}>
                {t('sync.stamp')}
              </button>
            )}
          </div>
          <p className="small muted">{t('sync.range', { min: fmt(range.min), max: fmt(range.max) })}</p>
        </fieldset>
      )}
      <p className="small muted sync-studio__wavenote">{t(wave === 'failed' ? 'sync.wave.failed' : 'sync.wave.note')}</p>

      <fieldset className="sync-studio__fix">
        <legend>{t('sync.whole')}</legend>
        <div className="sync-studio__row">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeAll(0.1)} disabled={saving}>
            {t('sync.later', { s: '0.1' })}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeAll(-0.1)} disabled={saving}>
            {t('sync.earlier', { s: '0.1' })}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeAll(0.5)} disabled={saving}>
            {t('sync.later', { s: '0.5' })}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudgeAll(-0.5)} disabled={saving}>
            {t('sync.earlier', { s: '0.5' })}
          </button>
        </div>
      </fieldset>

      <ErrorNotice error={saveError} />
      <div className="sync-studio__bar" aria-live="polite">
        <span>{draft ? t('sync.unsaved') : justSaved ? t('sync.saved') : t('sync.clean')}</span>
        <span className="sync-studio__row">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onUndo} disabled={!canUndo || saving}>
            {t('sync.undo')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRedo} disabled={!canRedo || saving}>
            {t('sync.redo')}
          </button>
          {draft && (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDraft(null)} disabled={saving}>
                {t('sync.discard')}
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={saving}>
                {t(saving ? 'sync.saving' : 'sync.save')}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
