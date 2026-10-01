import { useEffect, useState } from 'react';
import type { LyricTimings } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { formatTime, usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { Eq } from './Eq';
import { SyncedLyrics } from './SyncedLyrics';

/**
 * Now Playing — the full-screen listening view.
 *
 * Laid out like a record on a desk: the lyrics scroll on the left, the song's
 * sleeve sits as the label of a record turning on the right, and the transport
 * lives in a dock along the bottom. The record turns only while audio actually
 * plays (and not at all under reduced motion); paused, it stops where it is.
 */
export function NowPlaying({
  lyrics,
  timings,
  onClose,
  onDownload,
  title,
  artist,
  coverSeed,
  styles,
}: {
  lyrics: string | null;
  timings?: LyricTimings | null;
  onClose: () => void;
  onDownload?: () => void;
  title: string;
  artist: string;
  coverSeed: number;
  styles?: readonly string[];
}) {
  const { t } = useI18n();
  const player = usePlayer();
  const [closing, setClosing] = useState(false);
  const playing = player.status === 'playing';
  const duration = player.duration || player.current?.durationSeconds || 0;
  const at = Math.min(player.currentTime, duration || player.currentTime);
  const progress = duration ? (at / duration) * 100 : 0;

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 140);
  };

  // Esc leaves the view, as every other sheet in the product does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`now-playing${closing ? ' is-closing' : ''}`} role="dialog" aria-label={t('player.nowPlaying')}>
      {/* The sleeve's own colour, blown up and blurred, tints the room. */}
      <div className="now-playing__halo" aria-hidden="true">
        <CoverArt seed={coverSeed} title={title} styles={styles} className="now-playing__halo-art" />
      </div>

      <header className="now-playing__top">
        <button type="button" className="btn-icon" onClick={close} aria-label={t('player.close')}>
          <span className="icon icon--next is-flipped" aria-hidden="true" />
        </button>
        <div className="now-playing__now">
          <Eq live={playing} /> {playing ? t('player.nowPlaying') : t('player.paused')}
        </div>
      </header>

      <div className="now-playing__stage">
        <section className="now-playing__words">
          <h1 className="now-playing__title">{title}</h1>
          <p className="now-playing__artist">{artist}</p>
          {lyrics ? (
            <div className="now-playing__lyrics">
              <SyncedLyrics
                lyrics={lyrics}
                duration={duration || 120}
                currentTime={player.currentTime}
                timings={timings}
                onSeek={player.seek}
              />
            </div>
          ) : (
            <p className="now-playing__no-lyrics">{t('lyrics.instrumental')}</p>
          )}
        </section>

        <div className="now-playing__deck" aria-hidden="true">
          <div className={`vinyl${playing ? ' is-spinning' : ''}`}>
            <div className="vinyl__grooves" />
            <div className="vinyl__label">
              <CoverArt seed={coverSeed} title={title} styles={styles} className="vinyl__art" />
            </div>
            <div className="vinyl__spindle" />
          </div>
        </div>
      </div>

      <footer className="now-playing__dock">
        <div className="now-playing__dock-meta">
          <strong>{title}</strong>
          <span>{artist}</span>
        </div>

        <div className="now-playing__dock-center">
          <div className="now-playing__transport">
            <button type="button" className="btn-icon" onClick={player.prev} aria-label={t('player.prev')} disabled={!player.queue.length}>
              <span className="icon icon--prev" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`btn-icon btn-icon--main${playing ? ' is-playing' : ''}`}
              onClick={player.toggle}
              aria-label={playing ? t('player.pause') : t('player.play')}
            >
              <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
            </button>
            <button type="button" className="btn-icon" onClick={player.next} aria-label={t('player.next')} disabled={!player.queue.length}>
              <span className="icon icon--next" aria-hidden="true" />
            </button>
          </div>
          <div className="now-playing__timeline">
            <span className="num">{formatTime(at)}</span>
            <input
              type="range"
              className="now-playing__seek"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={at}
              onChange={(e) => player.seek(Number(e.target.value))}
              aria-label={t('player.play')}
              aria-valuetext={`${formatTime(at)} / ${formatTime(duration)}`}
              style={{ '--progress': `${progress.toFixed(2)}%` } as React.CSSProperties}
            />
            <span className="num">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="now-playing__dock-actions">
          {onDownload && (
            <button type="button" className="text-action" onClick={onDownload}>
              {t('song.download')}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
