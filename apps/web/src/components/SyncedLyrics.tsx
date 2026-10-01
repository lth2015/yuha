import { useEffect, useMemo, useRef } from 'react';
import type { LyricTimings } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { activeLineIndex, buildLyricTimeline, lineProgress } from '../lib/lyrics';

/**
 * Karaoke lyrics: the active line lifts, brightens and fills left-to-right;
 * sung lines settle back, upcoming lines wait dimmed. Clicking a line seeks
 * the player to it.
 *
 * Timing source is chosen honestly: model-aligned timings (`timings`) when
 * the song carries them, our deterministic estimate otherwise — and the pill
 * says which, because "estimated" and "word-synced" are different promises.
 */
export function SyncedLyrics({
  lyrics,
  duration,
  currentTime,
  timings,
  onSeek,
  compact = false,
}: {
  lyrics: string;
  duration: number;
  currentTime: number;
  timings?: LyricTimings | null;
  onSeek?: (seconds: number) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const lines = useMemo(
    () => (timings?.lines?.length ? timings.lines : buildLyricTimeline(lyrics, duration).lines),
    [timings, lyrics, duration],
  );
  const source = timings?.lines?.length ? timings.source : ('estimated' as const);
  const active = activeLineIndex(lines, currentTime);
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
    <div
      ref={scrollRef}
      className={`lyrics-sync${compact ? ' lyrics-sync--compact' : ''}`}
      role="list"
      aria-label={t('song.lyrics')}
      data-source={source}
    >
      <span className={`lyrics-sync__pill${source === 'aligned' ? ' is-aligned' : ''}`}>
        {t(source === 'aligned' ? 'lyrics.aligned' : 'lyrics.estimated')}
      </span>
      {lines.map((line, i) => {
        const state = i < active ? 'past' : i === active ? 'active' : 'future';
        const fill = i === active ? lineProgress(lines, i, currentTime) : state === 'past' ? 1 : 0;
        return (
          <div key={i} role="listitem" className="lyrics-sync__section">
            {line.section && (i === 0 || lines[i - 1]!.section !== line.section) && (
              <span className="lyrics-sync__marker">{line.section}</span>
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
  );
}
