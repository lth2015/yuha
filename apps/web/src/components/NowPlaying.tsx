import { useState } from 'react';
import type { LyricTimings } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { Eq } from './Eq';
import { SyncedLyrics } from './SyncedLyrics';

/**
 * Now Playing — the full-screen listening view.
 *
 * A light glass sheet over the app: cover centre stage, transport, and the
 * lyrics singing along in sync. Reached from the player bar's expand button.
 */
export function NowPlaying({
  lyrics,
  timings,
  onClose,
  onDownload,
  title,
  artist,
  coverSeed,
}: {
  lyrics: string | null;
  timings?: LyricTimings | null;
  onClose: () => void;
  onDownload?: () => void;
  title: string;
  artist: string;
  coverSeed: number;
}) {
  const { t } = useI18n();
  const player = usePlayer();
  const [closing, setClosing] = useState(false);
  const playing = player.status === 'playing';
  const duration = player.duration || player.current?.durationSeconds || 0;

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 140);
  };

  return (
    <div className={`now-playing${closing ? ' is-closing' : ''}`} role="dialog" aria-label={t('player.nowPlaying')}>
      <div className="now-playing__scrim" onClick={close} aria-hidden="true" />

      <header className="now-playing__top">
        <button type="button" className="btn-icon" onClick={close} aria-label={t('player.close')}>
          <span className="icon icon--next is-flipped" aria-hidden="true" />
        </button>
        <div className="now-playing__now">
          <Eq live={playing} /> {playing ? t('player.nowPlaying') : t('player.paused')}
        </div>
        <div className="now-playing__top-spacer" />
      </header>

      <div className="now-playing__body">
        <div className="now-playing__cover-wrap">
          <CoverArt
            seed={coverSeed}
            title={title}
            size={560}
            className={`now-playing__cover${playing ? ' is-breathing' : ''}`}
          />
          <div className="now-playing__meta">
            <h1 className="now-playing__title">{title}</h1>
            <p className="now-playing__artist">{artist}</p>
          </div>

          <div className="now-playing__transport">
            <button type="button" className="btn-icon" onClick={player.prev} aria-label={t('player.prev')} disabled={!player.queue.length}>
              <span className="icon icon--prev" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`btn-icon btn-icon--main${playing ? ' is-playing' : ''}`}
              onClick={player.toggle}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              <span className={playing ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
            </button>
            <button type="button" className="btn-icon" onClick={player.next} aria-label={t('player.next')} disabled={!player.queue.length}>
              <span className="icon icon--next" aria-hidden="true" />
            </button>
          </div>

          <input
            type="range"
            className="now-playing__seek"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            value={Math.min(player.currentTime, duration)}
            onChange={(e) => player.seek(Number(e.target.value))}
            aria-label={t('player.play')}
            style={{ '--progress': `${duration ? ((Math.min(player.currentTime, duration) / duration) * 100).toFixed(2) : 0}%` } as React.CSSProperties}
          />

          <div className="now-playing__actions">
            {onDownload && (
              <button type="button" className="btn btn--sm" onClick={onDownload}>
                {t('song.download')}
              </button>
            )}
          </div>
        </div>

        {lyrics && (
          <div className="now-playing__lyrics">
            <SyncedLyrics
              lyrics={lyrics}
              duration={duration || 120}
              currentTime={player.currentTime}
              timings={timings}
              onSeek={player.seek}
            />
          </div>
        )}
      </div>
    </div>
  );
}
