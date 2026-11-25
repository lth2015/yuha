import { useEffect, useMemo, useRef, useState } from 'react';
import { markCorrected, setLineStart, shiftTimings, type LyricTimings } from '@yuha/contracts';
import { ApiError, apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { activeLineIndex, resolveLyricTimings } from '../lib/lyrics';
import { usePlayer } from '../lib/player';
import { lineRange, loopRange, moveLine, windowAround } from '../lib/sync-studio';
import { ErrorNotice } from './common';

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
const SPAN_LINE = 12;
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
      if (s >= loop.to || s < loop.from - 0.5) player.seek(loop.from);
    });
  }, [loop, active, player]);
  const listen = () => {
    if (loop) return setLoop(null);
    const range = loopRange(lines, sel, duration);
    setLoop(range);
    seek(range.from);
  };
  useEffect(() => setLoop(null), [sel]);

  const [zoom, setZoom] = useState<'line' | 'song'>('line');
  /*
   * Held still while a block is dragged: the window follows the chosen line,
   * and following it mid-drag slid the waveform under a block that stayed put.
   */
  const [frozen, setFrozen] = useState<{ from: number; to: number } | null>(null);
  const view =
    frozen ??
    (zoom === 'song' ? { from: 0, to: duration } : windowAround(line ? (line.start + line.end) / 2 : 0, SPAN_LINE, duration));
  const span = Math.max(0.1, view.to - view.from);
  const pct = (s: number) => `${(((s - view.from) / span) * 100).toFixed(2)}%`;
  /*
   * A block is drawn inside the window and short of the next line, with a
   * hair of gap: a line that runs to the edge, or whose end overlaps the
   * next start in the data, would otherwise spill past the timeline or sit
   * on top of its neighbour.
   */
  const blockStyle = (from: number, to: number) => {
    const a = Math.max(from, view.from);
    const b = Math.min(to, view.to);
    return { left: pct(a), width: `calc(${pct(b)} - ${pct(a)} - 2px)` };
  };

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
    const w = (c.width = c.clientWidth * (window.devicePixelRatio || 1));
    const h = (c.height = c.clientHeight * (window.devicePixelRatio || 1));
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).color;
    const perSecond = wave.peaks.length / Math.max(0.1, wave.seconds);
    for (let x = 0; x < w; x += 2) {
      const s = view.from + (x / w) * span;
      const p = wave.peaks[Math.floor(s * perSecond)] ?? 0;
      const bar = Math.max(1, p * h * 0.9);
      g.fillRect(x, (h - bar) / 2, 1.5, bar);
    }
  }, [wave, view.from, span]);

  // Dragging the chosen line's block moves its start; one undo step per drag.
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; base: LyricTimings; start: number } | null>(null);
  const timeAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return view.from + ((clientX - box.left) / Math.max(1, box.width)) * span;
  };

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
          <span className="sync-studio__zoom" role="group" aria-label={t('sync.zoom')}>
            <button type="button" className="chip chip--btn" aria-pressed={zoom === 'line'} onClick={() => setZoom('line')}>
              {t('sync.zoom.line')}
            </button>
            <button type="button" className="chip chip--btn" aria-pressed={zoom === 'song'} onClick={() => setZoom('song')}>
              {t('sync.zoom.song')}
            </button>
          </span>
        </div>
      </div>

      <div
        ref={track}
        className="sync-studio__timeline"
        aria-label={t('sync.timeline')}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('.sync-studio__block')) return;
          // Going somewhere else ends the loop; otherwise it would pull straight back.
          setLoop(null);
          seek(Math.max(0, Math.min(duration, timeAt(e.clientX))));
        }}
      >
        <canvas ref={canvas} className="sync-studio__wave" aria-hidden="true" />
        {lines.map((l, i) =>
          l.end < view.from || l.start > view.to ? null : (
            <button
              key={i}
              type="button"
              className={`sync-studio__block${i === sel ? ' is-selected' : ''}${i === current ? ' is-current' : ''}`}
              style={blockStyle(l.start, Math.min(l.end, lines[i + 1]?.start ?? l.end))}
              aria-label={`${i + 1}. ${l.text} ${fmt(l.start)}`}
              aria-pressed={i === sel}
              onClick={() => setSelected(i)}
              onPointerDown={(e) => {
                if (i !== sel || saving) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, base: draft ?? saved, start: l.start };
                setFrozen(view);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || !track.current) return;
                const seconds = ((e.clientX - d.x) / Math.max(1, track.current.getBoundingClientRect().width)) * span;
                if (Math.abs(seconds) < 0.02) return;
                setDragging(setLineStart(d.base, sel, d.start + seconds, duration));
              }}
              onPointerUp={() => {
                drag.current = null;
                if (dragging) commit(dragging);
                setDragging(null);
                setFrozen(null);
              }}
              onPointerCancel={() => {
                drag.current = null;
                setDragging(null);
                setFrozen(null);
              }}
            >
              <span>{l.text}</span>
            </button>
          ),
        )}
        {active && now >= view.from && now <= view.to && <span className="sync-studio__cursor" style={{ left: pct(now) }} aria-hidden="true" />}
      </div>
      <p className="small muted sync-studio__wavenote">{t(wave === 'failed' ? 'sync.wave.failed' : 'sync.wave.note')}</p>

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

      <ol className="sync-studio__lines">
        {lines.map((l, i) => (
          <li key={i}>
            <button
              type="button"
              className={`sync-studio__line${i === sel ? ' is-selected' : ''}${i === current ? ' is-current' : ''}`}
              aria-pressed={i === sel}
              onClick={() => setSelected(i)}
            >
              <span className="num">{fmt(l.start)}</span> {l.text}
            </button>
          </li>
        ))}
      </ol>

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
