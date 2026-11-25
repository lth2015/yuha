import { useEffect, useMemo, useRef, useState } from 'react';
import { lrcFileName, markCorrected, setLineStart, shiftTimings, toLrc, type LyricTimings } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { activeLineIndex, resolveLyricTimings, lineProgress } from '../lib/lyrics';
import { usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { Snow } from './HolidayOpening';

/**
 * Karaoke lyrics: the active line lifts, brightens and fills left-to-right;
 * sung lines settle back, upcoming lines wait dimmed. Clicking a line seeks
 * the player to it.
 *
 * Timing source is chosen honestly: model-aligned timings (`timings`) when
 * the song carries them, our deterministic estimate otherwise — and the pill
 * says which, because "estimated" and "word-synced" are different promises.
 */
/**
 * The music model's section tags (`[verse]`, `[chorus]`…) in the reader's
 * language. They were printed as written, so a Chinese page read VERSE /
 * CHORUS between lines while the studio's own section buttons say 主歌 / 副歌.
 * A tag the creator wrote in their own language is already readable.
 */
const SECTION_KEYS: Record<string, string> = {
  intro: 'create.section.intro',
  verse: 'create.section.verse',
  chorus: 'create.section.chorus',
  bridge: 'create.section.bridge',
  rap: 'create.section.rap',
  interlude: 'create.section.interlude',
  'pre-chorus': 'lyrics.section.prechorus',
  outro: 'lyrics.section.outro',
  solo: 'lyrics.section.solo',
  instrumental: 'lyrics.section.instrumental',
};

export function SyncedLyrics({
  lyrics,
  duration,
  currentTime,
  timings,
  onSeek,
  title,
  artist,
  onSaveTimings,
  compact = false,
  live = true,
  tuneRequest = 0,
}: {
  lyrics: string;
  duration: number;
  currentTime: number;
  timings?: LyricTimings | null;
  onSeek?: (seconds: number) => void;
  title?: string | null;
  artist?: string | null;
  /** Owner only. Absent means the correction controls are not offered. */
  onSaveTimings?: (timings: LyricTimings) => Promise<void>;
  /** Bumped by "line them up first" on the video card: open the timing tools. */
  tuneRequest?: number;
  compact?: boolean;
  /**
   * Whether the player is playing THIS song. The frame-rate clock below is
   * the player's, whatever it is playing; a page showing another song must
   * not follow it.
   */
  live?: boolean;
}) {
  const { t } = useI18n();
  /*
   * One timeline object, whichever way it was produced, so the lines on
   * screen and the lines in a downloaded .lrc are the same array rather than
   * two computations that can drift.
   */
  const timeline: LyricTimings = useMemo(
    () => resolveLyricTimings(lyrics, duration, timings),
    [timings, lyrics, duration],
  );
  /*
   * Correction is the only half of lyric timing a person can fix.
   *
   * Nothing can be corrected before the song is made: the music service takes
   * no timing input, so a timestamp edited beforehand would be a wish it
   * never reads. Afterwards the audio is fixed, a late line is a fact, and
   * fixing it costs nothing — no credit, no re-generation, no waiting.
   */
  const [draft, setDraft] = useState<LyricTimings | null>(null);
  const [saving, setSaving] = useState(false);
  const [offset, setOffset] = useState(0);
  /** The owner opened the timing tools (folded away by default). */
  const [tuning, setTuning] = useState(false);
  useEffect(() => {
    if (tuneRequest > 0 && onSaveTimings) setTuning(true);
  }, [tuneRequest]);
  const shown = draft ?? timeline;
  const lines = shown.lines;
  const source = shown.source;


  const downloadLrc = () => {
    const url = URL.createObjectURL(
      new Blob([toLrc(shown, { title, artist, durationSeconds: duration })], {
        type: 'text/plain;charset=utf-8',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = lrcFileName(title);
    a.click();
    URL.revokeObjectURL(url);
  };

  /*
   * The playhead at frame rate, not at `timeupdate`'s four times a second.
   *
   * `currentTime` arrives as a prop from the player's React state, which is
   * written on `timeupdate` — so a line could not light up until as much as
   * 250ms after it was sung, on every line, and the karaoke fill advanced in
   * four visible steps a second. Subscribing to `onTime` reads the audio
   * element directly inside a requestAnimationFrame loop.
   *
   * The prop is still what this falls back to, and still what updates while
   * paused or seeking, so a song that is not playing shows the right line.
   *
   * Only while `live`. The subscription is to the player, not to this song:
   * with song A in the player bar and song B's page open, B's lines lit up
   * and scrolled in time with A — the same leak SongDetail's `active` guard
   * on `currentTime` had closed once already, reopened by this clock.
   */
  const [frameTime, setFrameTime] = useState(currentTime);
  useEffect(() => setFrameTime(currentTime), [currentTime]);
  const player = usePlayer();
  useEffect(() => (live ? player.onTime(setFrameTime) : undefined), [player, live]);
  const liveTime = live ? frameTime : currentTime;

  const active = activeLineIndex(lines, liveTime);
  /*
   * In a holiday season, a line about snow brings a little snow while it is
   * sung (docs/HOLIDAY_SPEC.md). Once per line, and only while playing.
   */
  const { runtime } = useSession();
  const snowed = useRef(new Set<number>());
  const [snowing, setSnowing] = useState(false);
  useEffect(() => {
    if (!runtime?.season || !live || active < 0 || snowed.current.has(active)) return;
    if (!/雪|snow/i.test(lines[active]?.text ?? '')) return;
    snowed.current.add(active);
    setSnowing(true);
    const id = window.setTimeout(() => setSnowing(false), 6000);
    return () => window.clearTimeout(id);
  }, [active, live, runtime?.season, lines]);

  const nudge = (seconds: number) => {
    setDraft((d) => shiftTimings(d ?? timeline, seconds, duration));
    setOffset((o) => Number((o + seconds).toFixed(1)));
  };

  const stampLine = (index: number) => {
    setDraft((d) => setLineStart(d ?? timeline, index, liveTime, duration));
  };

  const saveTimings = async () => {
    if (!draft || !onSaveTimings) return;
    setSaving(true);
    try {
      await onSaveTimings(markCorrected(draft));
      setDraft(null);
      setOffset(0);
    } finally {
      setSaving(false);
    }
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keep the active line centered — the Apple Music move.
  useEffect(() => {
    const container = scrollRef.current;
    const el = lineRefs.current[active];
    if (!container || !el) return;
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
      behavior: 'smooth',
    });
  }, [active]);

  if (!lines.length) {
    return <p className="muted small">{t('lyrics.instrumental')}</p>;
  }

  return (
    <>
    {snowing && <Snow flakes={14} />}
    <div
      ref={scrollRef}
      className={`lyrics-sync${compact ? ' lyrics-sync--compact' : ''}`}
      role="list"
      aria-label={t('song.lyrics')}
      data-source={source}
    >
      {/*
        Timing tools are the owner's, and folded away until asked for. A
        listener — the owner most of the time, a friend who was sent the link
        the rest — came to read the words; "估算同步", ±0.5 s buttons and an
        explanation of forced alignment were in the way for both.
      */}
      {onSaveTimings && !compact && (
        <div className="lyrics-sync__toolbar">
          <button type="button" className="lyrics-sync__tune" aria-expanded={tuning} onClick={() => setTuning((v) => !v)}>
            {t(tuning ? 'lyrics.tune.close' : 'lyrics.tune.open')}
          </button>
        </div>
      )}
      {tuning && onSaveTimings && (
      <div className="lyrics-sync__head">
        <span className={`lyrics-sync__pill${source === 'estimated' ? '' : ' is-aligned'}`}>
          {t(source === 'corrected' ? 'lyrics.corrected' : source === 'aligned' ? 'lyrics.aligned' : 'lyrics.estimated')}
        </span>
        {!compact && lines.length > 0 && (
          <span className="lyrics-sync__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudge(-0.5)}>
              {t('lyrics.earlier')}
            </button>
            <span className="lyrics-sync__offset num" aria-live="polite">
              {offset > 0 ? `+${offset.toFixed(1)}` : offset.toFixed(1)}s
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => nudge(0.5)}>
              {t('lyrics.later')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={downloadLrc}>
              {t('lyrics.download')}
            </button>
          </span>
        )}
      </div>
      )}
      {draft && onSaveTimings && (
        <div className="lyrics-sync__bar">
          <span>{t('lyrics.unsaved')}</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={saveTimings} disabled={saving}>
            {t(saving ? 'lyrics.saving' : 'lyrics.save')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setDraft(null);
              setOffset(0);
            }}
            disabled={saving}
          >
            {t('lyrics.revert')}
          </button>
        </div>
      )}
      {/*
        Said in full, on the songs that have the problem, rather than left to
        a two-word pill. "Estimated" is the answer to every report that the
        words run ahead of the voice, and nobody reads a pill — this has been
        reported three times against songs that were never aligned at all.
      */}
      {tuning && !compact && source === 'estimated' && (
        <p className="lyrics-sync__note">{t('lyrics.estimated.why')}</p>
      )}
      {lines.map((line, i) => {
        const state = i < active ? 'past' : i === active ? 'active' : 'future';
        const fill = i === active ? lineProgress(lines, i, liveTime) : state === 'past' ? 1 : 0;
        return (
          <div key={i} role="listitem" className="lyrics-sync__section">
            {line.section && (i === 0 || lines[i - 1]!.section !== line.section) && (
              <span className="lyrics-sync__marker">
                {SECTION_KEYS[line.section.trim().toLowerCase()] ? t(SECTION_KEYS[line.section.trim().toLowerCase()]!) : line.section}
              </span>
            )}
            <button
              type="button"
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={`lyrics-sync__line is-${state}`}
              style={{ '--fill': `${(fill * 100).toFixed(1)}%` } as React.CSSProperties}
              onClick={() => onSeek?.(Math.max(0, line.start - 0.4))}
              title={onSeek ? t('lyrics.playFrom') : undefined}
            >
              <span className="lyrics-sync__text">{line.text}</span>
              <span className="lyrics-sync__fill" aria-hidden="true">
                {line.text}
              </span>
            </button>
            {/*
              Tap a line at the moment it is sung. One line at a time and the
              neighbours stay put, because correcting by ear is a sequence of
              small decisions and a control that dragged the rest would undo
              the ones already made. Only while the song is playing — pinning
              a line to a stopped playhead is not a correction, it is a way to
              lose one.
            */}
            {onSaveTimings && tuning && live && player.status === 'playing' && (
              <button
                type="button"
                className="btn btn--ghost btn--sm lyrics-sync__stamp"
                onClick={() => stampLine(i)}
                title={t('lyrics.stamp.hint')}
              >
                {t('lyrics.stamp')}
              </button>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}
