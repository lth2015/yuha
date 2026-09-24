import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { messageFor, PROMPT_HINTS, type UserMessage } from '../lib/messages';
import { ApiError } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';

/**
 * Error display. Every failure shows a cause AND a next step (UI-12), and a
 * blocked prompt additionally shows the rewrite hint the server returned.
 */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  const msg: UserMessage = messageFor(error);
  const hintKey =
    error instanceof ApiError
      ? (error.details as { hintKey?: string } | undefined)?.hintKey
      : undefined;
  const appealable =
    error instanceof ApiError
      ? (error.details as { appealable?: boolean } | undefined)?.appealable
      : false;

  return (
    <div className={`alert alert--${msg.tone}`} role="alert" aria-live="assertive">
      <div className="alert__title">{msg.title}</div>
      <div>{msg.next}</div>
      {hintKey && PROMPT_HINTS[hintKey] && <div className="alert__next">{PROMPT_HINTS[hintKey]}</div>}
      {appealable && (
        <div className="alert__next small">
          {t('common.rightsNotice')}
          <Link to="/help/rights">{t('common.rightsReport')}</Link>
          {t('common.rightsNotice2')}
        </div>
      )}
      {onRetry && (
        <div style={{ marginTop: 'var(--s2)' }}>
          <button type="button" className="btn btn--secondary" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Panel({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || action) && (
        <div className="row row--between" style={{ marginBottom: 'var(--s2)' }}>
          {title && <h2 style={{ margin: 0, fontSize: 20 }}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3 style={{ color: 'var(--text)' }}>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label ?? t('common.loading')}</span>
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '70%' }} />
    </div>
  );
}

/**
 * Audio player control.
 *
 * Shares one audio element via the player context, so pressing play here stops
 * whatever was playing elsewhere (UI-01/UI-05). The scrubber is a native range
 * input, which gives keyboard seeking for free (UI-14).
 */
export function AudioPlayer({
  id,
  url,
  label,
  compact = false,
}: {
  id: string;
  url: string | null;
  label: string;
  compact?: boolean;
}) {
  const player = usePlayer();
  const isActive = player.activeId === id;
  const isPlaying = isActive && player.status === 'playing';
  const isLoading = isActive && player.status === 'loading';
  const failed = isActive && player.status === 'error';

  if (!url) {
    return (
      <div className="player">
        <span className="muted small">No playable audio yet</span>
      </div>
    );
  }

  const duration = isActive && player.duration ? player.duration : 30;
  const current = isActive ? player.currentTime : 0;

  const startOrToggle = () => {
    if (isActive) player.toggle();
    else
      player.play({
        trackId: id,
        title: label,
        artistName: null,
        coverSeed: 0,
        durationSeconds: duration,
        vocalMode: 'instrumental',
        previewUrl: url,
      });
  };

  return (
    <div className="player row" style={{ alignItems: 'center' }}>
      <button
        type="button"
        className={`btn-icon${isPlaying ? '' : ' btn-icon--main'}`}
        onClick={startOrToggle}
        aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
      >
        <span className={isLoading ? 'spinner' : isPlaying ? 'icon icon--pause' : 'icon icon--play'} aria-hidden="true" />
      </button>

      {!compact && (
        <>
          <input
            type="range"
            className="player__scrub"
            min={0}
            max={Math.max(duration, 1)}
            step={0.1}
            value={current}
            onChange={(e) => {
              if (!isActive) startOrToggle();
              player.seek(Number(e.target.value));
            }}
            aria-label={`Play position of ${label}`}
            aria-valuetext={`${formatTime(current)} / ${formatTime(duration)}`}
          />
          <span className="player__time" aria-hidden="true">
            {formatTime(current)} / {formatTime(duration)}
          </span>
        </>
      )}

      {failed && (
        <span className="small" style={{ color: 'var(--danger)' }} role="alert">
          Playback failed — please try again in a moment.
        </span>
      )}
    </div>
  );
}

/**
 * UI-04: coarse stages with an honest time range. There is deliberately no
 * percentage — we do not know how far along the upstream is, and inventing a
 * number would be a lie the user could act on.
 */
const STAGE_ORDER = ['validating', 'queued', 'generating', 'processing', 'verifying'] as const;

export function StageIndicator({ phase, delayed }: { phase: string; delayed: boolean }) {
  const { t } = useI18n();
  const index = STAGE_ORDER.indexOf(phase as (typeof STAGE_ORDER)[number]);
  return (
    <div className="stack stack--tight">
      <div className="stages" role="img" aria-label={t('common.progressAria', { phase })}>
        {STAGE_ORDER.map((s, i) => (
          <div
            key={s}
            className={`stage ${i < index ? 'stage--done' : i === index ? 'stage--active' : ''}`}
          />
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {delayed
          ? t('common.slowJob')
          : t('common.normalJob')}
      </p>
    </div>
  );
}
