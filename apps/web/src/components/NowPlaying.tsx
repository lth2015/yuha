import { useEffect, useRef, useState } from 'react';
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
  downloadError,
  title,
  artist,
  coverSeed,
  styles,
}: {
  lyrics: string | null;
  timings?: LyricTimings | null;
  onClose: () => void;
  onDownload?: () => void;
  /** A failed export, shown here because this overlay covers the song page. */
  downloadError?: unknown;
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

  /*
   * Guarded, because it was not idempotent. Two Escapes inside the 140ms
   * close animation queued two `onClose` calls, and `Layout.closeNowPlaying`
   * calls `window.history.back()` each time — so the second one popped the
   * real page and threw the user off the screen they were on.
   */
  const closingRef = useRef(false);
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
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

  /*
   * A full-screen `role="dialog"` that never took focus.
   *
   * Pressing Expand left focus on the button underneath the overlay, so Tab
   * then walked the whole page behind it — nav, song cards, footer links — and
   * a screen reader read that page as if it were on top. `aria-modal` tells
   * assistive technology the rest is inert; moving focus in, and putting it
   * back where it came from on close, is what makes that true for a keyboard.
   */
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      ref={panel}
      tabIndex={-1}
      className={`now-playing${closing ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('player.nowPlaying')}
    >
      {/* The sleeve's own colour, blown up and blurred, tints the room. */}
      <div className="now-playing__halo" aria-hidden="true">
        <CoverArt seed={coverSeed} title={title} styles={styles} className="now-playing__halo-art" />
      </div>

      <header className="now-playing__top">
        {/* A labelled control, not a bare rotated arrow: people looked for a
            way out of this view and did not read the arrow as one. Esc and
            the browser's Back button close it too. */}
        <button type="button" className="now-playing__collapse" onClick={close}>
          <span className="icon icon--collapse" aria-hidden="true" />
          {t('player.collapse')}
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

        <div className={`now-playing__deck${playing ? ' is-playing' : ''}`} aria-hidden="true">
          <div className="deck__platter">
            <div className={`vinyl${playing ? ' is-spinning' : ''}`}>
              <div className="vinyl__grooves" />
              <div className="vinyl__label">
                <CoverArt seed={coverSeed} title={title} styles={styles} className="vinyl__art" />
              </div>
              <div className="vinyl__spindle" />
            </div>
            {/* Light on the record does not turn with it. */}
            <div className="vinyl__sheen" />
            {/* The arm swings onto the record while it plays and parks when it stops. */}
            <svg className="tonearm" viewBox="0 0 120 320">
              <defs>
                <linearGradient id="tonearm-metal" x1="0" x2="1">
                  <stop offset="0" stopColor="#d9dbd5" />
                  <stop offset="0.5" stopColor="#ffffff" />
                  <stop offset="1" stopColor="#b9bcb4" />
                </linearGradient>
              </defs>
              <circle cx="80" cy="40" r="30" fill="#ecebe5" stroke="rgb(32 34 31 / 14%)" />
              <circle cx="80" cy="40" r="16" fill="url(#tonearm-metal)" stroke="rgb(32 34 31 / 20%)" />
              <path d="M80 40 L80 230 Q80 262 58 284" fill="none" stroke="url(#tonearm-metal)" strokeWidth="7" strokeLinecap="round" />
              <path d="M80 40 L80 230 Q80 262 58 284" fill="none" stroke="rgb(32 34 31 / 18%)" strokeWidth="1" />
              {/* Headshell in brushed metal with a petal cartridge, so it stays
                  visible against the black record it rests on. */}
              <g transform="rotate(38 55 293)">
                <path d="M70 282 L82 274" stroke="url(#tonearm-metal)" strokeWidth="3" strokeLinecap="round" />
                <rect x="40" y="276" width="30" height="34" rx="5" fill="url(#tonearm-metal)" stroke="rgb(32 34 31 / 35%)" />
                <rect x="44" y="296" width="22" height="11" rx="2.5" fill="#F46B45" stroke="rgb(32 34 31 / 25%)" />
                <rect x="53" y="307" width="4" height="4" rx="1" fill="#20221f" />
              </g>
            </svg>
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
              aria-label={t('player.seek')}
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
          {downloadError !== null && downloadError !== undefined && (
            <span className="player-bar__hint player-bar__hint--err" role="alert">
              {t('card.actionFailed')}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
