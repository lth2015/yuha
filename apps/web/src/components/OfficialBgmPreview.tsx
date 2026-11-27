import { useEffect, useRef, useState } from 'react';
import type { OfficialBgmItem } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { catalogTitle } from '../lib/official-bgm-copy';
import { formatTime, usePlayer } from '../lib/player';

export function OfficialBgmPreview({ track, endpoint, onClose }: {
  track: OfficialBgmItem;
  endpoint: string;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const title = catalogTitle(track, lang);
  const player = usePlayer();
  // Preview playback is confined to this route. The song player and this
  // excerpt player yield to each other when the user starts playback.
  const audio = useRef<HTMLAudioElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loop, setLoop] = useState(false);

  useEffect(() => { panel.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ url: string }>(`${endpoint}/${track.id}/preview`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setUrl(result.url); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [endpoint, track.id, attempt]);

  useEffect(() => {
    if (player.status === 'playing') audio.current?.pause();
  }, [player.status, player.activeId]);

  return (
    <section className="market-preview" ref={panel} tabIndex={-1} aria-label={t('market.previewTrack', { title })}>
      <div className="market-preview__top">
        <div className="market-preview__name">
          <strong>{title}</strong>
          <span className="small muted">{t('market.previewLength', { time: formatTime(track.previewSeconds) })}</span>
        </div>
        <button type="button" className="btn" onClick={onClose}>{t('market.close')}</button>
      </div>
      {failed ? (
        <div className="market-preview__top">
          <p role="alert" className="small">{t('market.previewError')}</p>
          <button type="button" className="btn" onClick={() => {
            setUrl(null);
            setFailed(false);
            setAttempt((n) => n + 1);
          }}>{t('market.retry')}</button>
        </div>
      ) : url ? (
        <>
          <audio ref={audio} aria-label={t('market.previewTrack', { title })}
            src={url} controls preload="metadata" loop={loop} controlsList="nodownload"
            onPlay={() => { if (player.status === 'playing' || player.status === 'loading') player.stop(); }}
            onError={() => setFailed(true)} />
          <label className="market-preview__loop"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />{t('market.loop')}</label>
        </>
      ) : <p role="status" className="small muted">{t('market.previewLoading')}</p>}
    </section>
  );
}
