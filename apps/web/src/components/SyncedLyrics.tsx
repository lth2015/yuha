import { useEffect, useMemo, useRef, useState } from 'react';
import { lrcFileName, toLrc, type LyricTimings } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { activeLineIndex, activeTrustedLine, resolveLyricTimings, lineProgress, trustedFlags } from '../lib/lyrics';
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
  canDownload = false,
  compact = false,
  live = true,
  still = false,
}: {
  lyrics: string;
  duration: number;
  currentTime: number;
  timings?: LyricTimings | null;
  onSeek?: (seconds: number) => void;
  title?: string | null;
  artist?: string | null;
  /** The signed-in owner can download from the song page. */
  canDownload?: boolean;
  compact?: boolean;
  /**
   * Whether the player is playing THIS song. The frame-rate clock below is
   * the player's, whatever it is playing; a page showing another song must
   * not follow it.
   */
  live?: boolean;
  /**
   * The platform is still syncing this song and nothing heard it yet: show
   * the words as they are, with no line lit. A highlight from an estimate
   * would look like a sync that has not happened.
   */
  still?: boolean;
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
  const { lines, source } = timeline;
  const { runtime } = useSession();
  const strict = Boolean(runtime?.features?.lyricStrictTimeline);
  const trusted = useMemo(() => trustedFlags(timeline, strict), [timeline, strict]);
  const lrcLines = strict ? lines.filter((_, i) => trusted[i]) : lines;

  const downloadLrc = () => {
    const url = URL.createObjectURL(
      new Blob([toLrc({ ...timeline, lines: lrcLines }, { title, artist, durationSeconds: duration })], {
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

  const active = still ? -1 : strict ? activeTrustedLine(lines, trusted, liveTime) : activeLineIndex(lines, liveTime);
  /*
   * In a holiday season, a line about snow brings a little snow while it is
   * sung (docs/HOLIDAY_SPEC.md). Once per line, and only while playing.
   */
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
    {canDownload && !compact && lrcLines.length > 0 && (
      <div className="lyrics-sync__download">
        <button type="button" className="btn btn--ghost btn--sm" onClick={downloadLrc}>
          {t('lyrics.download')}
        </button>
      </div>
    )}
    <div
      ref={scrollRef}
      className={`lyrics-sync${compact ? ' lyrics-sync--compact' : ''}`}
      role="list"
      aria-label={t('song.lyrics')}
      data-source={source}
    >
      {lines.map((line, i) => {
        // Strictly, a line is past only once it was trusted and sung: a gap lights nothing and dims nothing.
        const state = strict
          ? i === active ? 'active' : trusted[i] && liveTime >= line.end ? 'past' : 'future'
          : i < active ? 'past' : i === active ? 'active' : 'future';
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
          </div>
        );
      })}
    </div>
    </>
  );
}
