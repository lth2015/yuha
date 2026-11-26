import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LyricTimings, TrackView } from '@yuha/contracts';
import { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatTime, usePlayer } from '../lib/player';
import {
  SCENE_STYLES,
  defaultSceneClip,
  sceneActive,
  sceneMvClient,
  type SceneMvClient,
  type SceneMvJob,
  type SceneStyle,
} from '../lib/scene-mv';
import { useConfirm } from './ConfirmDialog';

export interface SceneMvSong {
  trackId: string;
  title: string;
  durationSeconds: number;
  previewUrl: string | null;
  lyricTimings?: LyricTimings | null;
  artistName?: TrackView['artistName'];
  coverSeed?: number;
  styles?: string[];
  vocalMode?: TrackView['vocalMode'];
  mood?: TrackView['mood'];
}
const STYLE_KEYS = {
  neon_rain: 'sceneMv.style.neon',
  seaside_sunset: 'sceneMv.style.sea',
  soft_watercolor: 'sceneMv.style.watercolor',
};
const STATUS_KEYS = {
  draft: 'sceneMv.status.draft',
  queued: 'sceneMv.status.queued',
  generating: 'sceneMv.status.generating',
  composing: 'sceneMv.status.composing',
  ready: 'sceneMv.status.ready',
  failed: 'sceneMv.status.failed',
  cancelled: 'sceneMv.status.cancelled',
};
const FAILURE_KEYS: Record<string, string> = {
  shot_failed: 'sceneMv.failure.shot',
  compose_failed: 'sceneMv.failure.compose',
  song_gone: 'sceneMv.failure.song',
  timeout: 'sceneMv.failure.timeout',
};

/** Server-backed work, separate from the on-device quick videos. */
export function SceneMv({ song, client = sceneMvClient }: { song: SceneMvSong; client?: SceneMvClient }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const player = usePlayer();
  const [confirm, dialog] = useConfirm();
  const [job, setJob] = useState<SceneMvJob | null>(null);
  const [history, setHistory] = useState<SceneMvJob[]>([]);
  const rootRef = useRef<HTMLElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [clip, setClip] = useState(() => defaultSceneClip(song.durationSeconds, song.lyricTimings));
  const [style, setStyle] = useState<SceneStyle>('seaside_sunset');
  const [description, setDescription] = useState('');
  const [shots, setShots] = useState<string[]>([]);
  const [media, setMedia] = useState<{ file: File; url: string } | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const selection = useRef<{ start: number; end: number; pending: boolean } | null>(null);
  const current = useRef({ job, player });
  current.current = { job, player };

  const accept = useCallback((next: SceneMvJob | null, focus = false, preserveDraft = false) => {
    // Returning to the tab refreshes server progress, not the person's
    // unconfirmed edits. A different task or terminal status still replaces it.
    const keepWords = preserveDraft && next?.status === 'draft' &&
      current.current.job?.status === 'draft' && next.id === current.current.job.id;
    setJob(next);
    if (!keepWords) setShots(next?.shots?.map((s) => s.prompt ?? '') ?? []);
    if (next) {
      setClip({ clipStart: next.clipStart, clipEnd: next.clipEnd });
      setStyle(next.style);
      setHistory((old) =>
        old.some((x) => x.id === next.id) ? old.map((x) => (x.id === next.id ? next : x)) : [next, ...old],
      );
    }
    if (focus) setFocusRequest((n) => n + 1);
  }, []);
  useEffect(() => {
    if (focusRequest)
      (
        rootRef.current?.querySelector<HTMLElement>('[data-scene-stage]') ??
        rootRef.current?.querySelector('h2')
      )?.focus();
  }, [focusRequest]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const stamp = ++generation.current;
      try {
        const id = current.current.job?.id;
        const next = id ? await client.get(id, signal) : null;
        const items = id ? null : await client.list(song.trackId, signal);
        if (signal?.aborted || !mounted.current || stamp !== generation.current) return;
        if (items) setHistory(items);
        const asked = new URLSearchParams(window.location.search).get('scene-mv');
        accept(
          next ??
            items?.find((x) => sceneActive(x.status)) ??
            items?.find((x) => x.id === asked) ??
            items?.[0] ??
            null,
          false,
          true,
        );
        setError(null);
      } catch (err) {
        if (!signal?.aborted && mounted.current && stamp === generation.current)
          setError(
            err instanceof ApiError && err.status === 503 ? 'sceneMv.unavailable' : 'sceneMv.readError',
          );
      } finally {
        if (!signal?.aborted && mounted.current && stamp === generation.current) setLoading(false);
      }
    },
    [accept, client, song.trackId],
  );
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mounted.current = false;
      ++generation.current;
      controller.abort();
    };
  }, [refresh]);
  useEffect(() => {
    const change = () => {
      const next = document.visibilityState !== 'hidden';
      setVisible(next);
      if (next && !guard.current) void refresh();
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, [refresh]);
  useEffect(() => {
    if (!visible || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted && sceneActive(current.current.job?.status ?? 'draft'))
        timer = setTimeout(tick, 12_000);
    };
    if (job && sceneActive(job.status)) timer = setTimeout(tick, 12_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [visible, busy, job?.id, job?.status, refresh]);

  const run = async (action: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    ++generation.current;
    setBusy(true);
    setError(null);
    setActiveId(null);
    try {
      await action();
    } catch (err) {
      if (!mounted.current) return;
      const other = err instanceof ApiError ? (err.details as { activeId?: unknown } | null)?.activeId : null;
      if (err instanceof ApiError && err.status === 409 && typeof other === 'string') {
        setActiveId(other);
        setError('sceneMv.busy');
      } else
        setError(
          err instanceof ApiError && err.status === 503 ? 'sceneMv.unavailable' : 'sceneMv.writeError',
        );
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const create = () =>
    run(async () => {
      const next = await client.create(song.trackId, {
        ...clip,
        style,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (mounted.current) accept(next, true);
    });
  const start = () =>
    run(async () => {
      if (!job || shots.length < 1 || shots.some((s) => !s.trim() || s.length > 300)) return;
      await client.patch(
        job.id,
        shots.map((s) => s.trim()),
      );
      await client.start(job.id);
      const next = await client.get(job.id);
      if (mounted.current) accept(next, true);
    });
  const cancel = () =>
    run(async () => {
      if (!job) return;
      await client.cancel(job.id);
      const next = await client.get(job.id);
      if (mounted.current) accept(next, true);
    });
  const reset = () => {
    ++generation.current;
    accept(null, true);
    setError(null);
    setActiveId(null);
    setOpen(true);
  };
  const remove = async () => {
    if (
      !job ||
      busy ||
      !(await confirm({ message: t('sceneMv.deleteAsk'), confirmLabel: t('sceneMv.delete'), danger: true }))
    )
      return;
    const id = job.id;
    void run(async () => {
      await client.remove(id);
      if (mounted.current) {
        setHistory((old) => old.filter((x) => x.id !== id));
        reset();
      }
    });
  };
  const viewActive = () =>
    run(async () => {
      if (!activeId) return;
      const other = await client.get(activeId);
      if (!mounted.current) return;
      if (other.trackId === song.trackId) accept(other, true);
      else
        navigate(
          `/song/${encodeURIComponent(other.trackId)}?scene-mv=${encodeURIComponent(other.id)}#scene-mv`,
        );
    });

  useEffect(() => {
    if (!previewing || !selection.current) return;
    const range = selection.current;
    if ((!range.pending && (player.activeId !== song.trackId || ['paused', 'idle', 'error'].includes(player.status))) ||
      (player.activeId === song.trackId && player.status === 'error')) {
      selection.current = null; setPreviewing(false); return;
    }
    if (player.activeId !== song.trackId || player.status !== 'playing') return;
    if (range.pending) {
      if (!player.duration || !Number.isFinite(player.duration)) return;
      range.pending = false;
      player.seek(range.start);
    }
    return player.onTime((time) => {
      if (selection.current !== range) return;
      if (time >= range.end) {
        selection.current = null;
        setPreviewing(false);
        player.toggle();
      }
    });
  }, [previewing, player.activeId, player.status, player.duration, player.seek, player.onTime, player.toggle, song.trackId]);
  const stopPreview = () => {
    selection.current = null;
    setPreviewing(false);
    if (player.activeId === song.trackId && player.status === 'playing') player.toggle();
  };
  const changeClip = (next: typeof clip) => {
    if (selection.current) stopPreview();
    setClip(next);
  };
  const preview = () => {
    if (previewing) { stopPreview(); return; }
    if (!song.previewUrl) return;
    selection.current = { start: clip.clipStart, end: clip.clipEnd, pending: true };
    setPreviewing(true);
    if (player.activeId !== song.trackId) {
      const track = {
        trackId: song.trackId,
        title: song.title,
        artistName: song.artistName ?? null,
        durationSeconds: song.durationSeconds,
        coverSeed: song.coverSeed ?? 0,
        styles: song.styles ?? [],
        vocalMode: song.vocalMode ?? ('instrumental' as const),
        mood: song.mood ?? null,
        previewUrl: song.previewUrl,
      };
      // A preview must not inherit the library's previous queue.
      player.play(track, [track]);
    } else if (player.status !== 'playing') player.toggle();
  };
  useEffect(
    () => () => {
      if (
        selection.current &&
        current.current.player.activeId === song.trackId &&
        current.current.player.status === 'playing'
      )
        current.current.player.toggle();
      selection.current = null;
    },
    [song.trackId],
  );

  const expiry = job?.expiresAt ? Date.parse(job.expiresAt) : NaN;
  const expired = Number.isFinite(expiry) && expiry <= Date.now();
  useEffect(() => {
    setMedia(null);
    setMediaError(false);
    if (!open || job?.status !== 'ready' || expired) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let url: string | null = null;
    void (async () => {
      try {
        const link = await client.download(job.id, controller.signal);
        const parsed = new URL(link.url, window.location.href);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid media URL');
        const res = await fetch(parsed.toString(), { signal: controller.signal, credentials: 'omit' });
        if (!res.ok) throw new Error('media unavailable');
        const blob = await res.blob();
        if (!blob.size || !blob.type.startsWith('video/')) throw new Error('not a video');
        if (controller.signal.aborted || disposed) return;
        const file = new File([blob], `${song.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'YUHA'}.mp4`, {
          type: 'video/mp4',
        });
        url = URL.createObjectURL(file);
        setMedia({ file, url });
      } catch {
        if (!disposed) setMediaError(true);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      if (url) URL.revokeObjectURL(url);
    };
  }, [job?.id, job?.status, job?.expiresAt, open, expired, client, mediaAttempt, song.title]);
  const canShare =
    media &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function' &&
    navigator.canShare({ files: [media.file] });
  const share = async () => {
    if (!media) return;
    try {
      await navigator.share({ files: [media.file] });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('sceneMv.shareError');
    }
  };
  const validShots =
    [1, 2, 3, 4].includes(shots.length) && shots.every((s) => s.trim() && s.length <= 300);
  const hasStoryboard = job?.shots?.length && job.shots.every((s) => typeof s.prompt === 'string');
  const length = clip.clipEnd - clip.clipStart;
  const count = Math.min(job?.total ?? 4, Math.max(0, job?.drawn ?? 0));

  return (
    <section ref={rootRef} className="scene-mv" id="scene-mv" aria-labelledby="scene-mv-heading">
      <header className="scene-mv__header">
        <div>
          <span className="scene-mv__eyebrow">{t('sceneMv.kicker')}</span>
          <h2 id="scene-mv-heading" tabIndex={-1}>
            {t('sceneMv.title')}
          </h2>
        </div>
        <button type="button" className="text-action" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t(open ? 'sceneMv.close' : 'sceneMv.open')}
        </button>
      </header>
      <p className="scene-mv__lead">{t('sceneMv.lead')}</p>
      <p className="small muted">{t('sceneMv.quick')}</p>
      {!open && job && <p role="status">{t(STATUS_KEYS[job.status])}</p>}
      {open && (
        <>
          {loading && <p role="status">{t('sceneMv.loading')}</p>}
          {(history.length > 1 || (!job && history.length > 0)) && (
            <div className="scene-mv__history">
              <label htmlFor="scene-mv-history">{t('sceneMv.history')}</label>
              <select
                id="scene-mv-history"
                value={job?.id ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) reset();
                  else
                    void run(async () => {
                      const next = await client.get(id);
                      if (mounted.current) accept(next, true);
                    });
                }}
              >
                <option value="">{t('sceneMv.newVideo')}</option>
                {history.map((v) => (
                  <option key={v.id} value={v.id}>
                    {t(STATUS_KEYS[v.status])} · {formatTime(v.clipStart)}–{formatTime(v.clipEnd)}
                    {v.createdAt
                      ? ` · ${new Date(v.createdAt).toLocaleString(lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja-JP' : 'en-US')}`
                      : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error && (
            <div className="alert scene-mv__error" role="alert">
              <p>{t(error)}</p>
              <div className="scene-mv__actions">
                {activeId ? (
                  <button className="btn" onClick={() => void viewActive()} disabled={busy}>
                    {t('sceneMv.viewActive')}
                  </button>
                ) : (
                  <button className="btn" onClick={() => void refresh()} disabled={busy}>
                    {t('sceneMv.refresh')}
                  </button>
                )}
              </div>
            </div>
          )}
          {!loading && !job && (
            <div className="scene-mv__form">
              <fieldset disabled={busy || Boolean(error)} className="scene-mv__selection">
                <legend>{t('sceneMv.clip')}</legend>
                <div className="scene-mv__range-label">
                  <span>
                    {formatTime(clip.clipStart)} — {formatTime(clip.clipEnd)}
                  </span>
                  <span>{t('sceneMv.seconds', { n: Math.round(length) })}</span>
                </div>
                <label htmlFor="scene-mv-start">{t('sceneMv.clipStart')}</label>
                <input
                  id="scene-mv-start"
                  type="range"
                  min={0}
                  max={Math.max(0, song.durationSeconds - length)}
                  step={0.1}
                  value={clip.clipStart}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                  changeClip({ clipStart: n, clipEnd: n + length });
                  }}
                />
                <label htmlFor="scene-mv-length">{t('sceneMv.clipLength')}</label>
                <input
                  id="scene-mv-length"
                  type="range"
                  min={Math.min(4, song.durationSeconds)}
                  max={Math.min(32, song.durationSeconds)}
                  step={1}
                  value={length}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const start = Math.min(clip.clipStart, song.durationSeconds - n);
                  changeClip({ clipStart: start, clipEnd: start + n });
                  }}
                />
                <button type="button" className="btn" onClick={preview} disabled={!song.previewUrl}>
                  {t(previewing ? 'sceneMv.stopPreview' : 'sceneMv.previewClip')}
                </button>
                <p className="small muted">{t('sceneMv.clipHint')}</p>
              </fieldset>
              <fieldset disabled={busy || Boolean(error)}>
                <legend>{t('sceneMv.style')}</legend>
                <div className="scene-mv__styles">
                  {SCENE_STYLES.map((s) => (
                    <label className={`scene-mv__style${style === s ? ' is-selected' : ''}`} key={s}>
                      <input
                        type="radio"
                        name="scene-mv-style"
                        value={s}
                        checked={style === s}
                        onChange={() => setStyle(s)}
                      />
                      <img src={`/scene-mv/${s}.svg`} alt="" width={320} height={240} />
                      <span>{t(STYLE_KEYS[s])}</span>
                    </label>
                  ))}
                </div>
                <p className="small muted">{t('sceneMv.artHint')}</p>
              </fieldset>
              <div>
                <label htmlFor="scene-mv-description">{t('sceneMv.description')}</label>
                <textarea
                  id="scene-mv-description"
                  rows={3}
                  maxLength={300}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy}
                  placeholder={t('sceneMv.placeholder')}
                />
                <p className="small muted">{t('sceneMv.descriptionHint')}</p>
              </div>
              <p className="scene-mv__wait">{t('sceneMv.wait')}</p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || Boolean(error) || length <= 0}
                onClick={() => void create()}
              >
                {t(busy ? 'sceneMv.planning' : 'sceneMv.plan')}
              </button>
            </div>
          )}
          {job?.status === 'draft' && (
            <div className="scene-mv__storyboard">
              <h3 data-scene-stage tabIndex={-1}>
                {t('sceneMv.status.draft')}
              </h3>
              <p>{t('sceneMv.confirmHint')}</p>
              {hasStoryboard ? (
                <ol className="scene-mv__shots">
                  {shots.map((prompt, i) => (
                    <li key={i}>
                      <label htmlFor={`scene-shot-${i}`}>{t('sceneMv.shot', { n: i + 1 })}</label>
                      <textarea
                        id={`scene-shot-${i}`}
                        rows={3}
                        maxLength={300}
                        value={prompt}
                        disabled={busy}
                        aria-describedby={
                          !prompt.trim() || prompt.length > 300 ? `scene-shot-error-${i}` : undefined
                        }
                        onChange={(e) => setShots((old) => old.map((v, j) => (j === i ? e.target.value : v)))}
                      />
                      {(!prompt.trim() || prompt.length > 300) && (
                        <p id={`scene-shot-error-${i}`} className="small" role="alert">
                          {t('sceneMv.promptLimit')}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{t('sceneMv.missingDraft')}</p>
              )}
              <p className="scene-mv__wait">{t('sceneMv.wait')}</p>
              <div className="scene-mv__actions">
                <button
                  className="btn btn--primary"
                  onClick={() => void start()}
                  disabled={!validShots || busy || Boolean(error)}
                >
                  {t(busy ? 'sceneMv.saving' : 'sceneMv.start')}
                </button>
                <button className="btn" onClick={reset} disabled={busy}>
                  {t('sceneMv.rebuild')}
                </button>
                <button className="text-action" onClick={() => void remove()} disabled={busy}>
                  {t('sceneMv.delete')}
                </button>
              </div>
            </div>
          )}
          {job && sceneActive(job.status) && (
            <div className="scene-mv__progress">
              <div className="scene-mv__status" role="status">
                <span className="scene-mv__status-dot" aria-hidden="true" />
                <h3 data-scene-stage tabIndex={-1}>
                  {t(STATUS_KEYS[job.status])}
                </h3>
              </div>
              {job.status === 'queued' && typeof job.aheadOfYou === 'number' && (
                <p>{t('sceneMv.ahead', { n: Math.max(0, job.aheadOfYou) })}</p>
              )}
              {job.status === 'generating' && (
                <>
                  <progress max={job.total || 4} value={count} aria-label={t('sceneMv.progress')} />
                  <p>{t('sceneMv.drawn', { n: count, total: job.total || 4 })}</p>
                </>
              )}
              <p>{t('sceneMv.leave')}</p>
              <p className="small muted">{t('sceneMv.wait')}</p>
              <p className="small muted">{t('sceneMv.cancelHint')}</p>
              <div className="scene-mv__actions">
                <button className="btn" onClick={() => void refresh()} disabled={busy}>
                  {t('sceneMv.refresh')}
                </button>
                <button className="text-action" onClick={() => void cancel()} disabled={busy}>
                  {t(busy ? 'sceneMv.saving' : 'sceneMv.cancel')}
                </button>
              </div>
            </div>
          )}
          {job?.status === 'ready' && (
            <div className="scene-mv__result">
              <h3 data-scene-stage tabIndex={-1}>
                {t('sceneMv.status.ready')}
              </h3>
              {Number.isFinite(expiry) && (
                <p>
                  {t('sceneMv.expires', {
                    time: new Date(expiry).toLocaleString(
                      lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja-JP' : 'en-US',
                    ),
                  })}
                </p>
              )}
              <p className="small muted">{t('sceneMv.saveHint')}</p>
              {expired ? (
                <p role="status">{t('sceneMv.expired')}</p>
              ) : media ? (
                <>
                  <video
                    src={media.url}
                    controls
                    playsInline
                    preload="metadata"
                    onPlay={() => {
                      if (player.status === 'playing') player.toggle();
                    }}
                  />
                  <div className="scene-mv__actions">
                    <a className="btn btn--primary" href={media.url} download={media.file.name}>
                      {t('sceneMv.download')}
                    </a>
                    {canShare && (
                      <button className="btn" onClick={() => void share()}>
                        {t('sceneMv.share')}
                      </button>
                    )}
                  </div>
                </>
              ) : mediaError ? (
                <div role="alert">
                  <p>{t('sceneMv.mediaError')}</p>
                  <button className="btn" onClick={() => setMediaAttempt((n) => n + 1)}>
                    {t('sceneMv.refreshMedia')}
                  </button>
                </div>
              ) : (
                <p role="status">{t('sceneMv.mediaLoading')}</p>
              )}
              <div className="scene-mv__actions">
                <button className="btn" onClick={reset}>
                  {t('sceneMv.another')}
                </button>
                <button className="text-action" onClick={() => void remove()} disabled={busy}>
                  {t('sceneMv.delete')}
                </button>
              </div>
            </div>
          )}
          {job && ['failed', 'cancelled'].includes(job.status) && (
            <div className="scene-mv__ended" role="status">
              <h3 data-scene-stage tabIndex={-1}>
                {t(STATUS_KEYS[job.status])}
              </h3>
              <p>
                {t(
                  job.status === 'cancelled'
                    ? 'sceneMv.cancelledHint'
                    : (FAILURE_KEYS[job.failure ?? ''] ?? 'sceneMv.failure.generic'),
                )}
              </p>
              <p>{t('sceneMv.noCredits')}</p>
              <div className="scene-mv__actions">
                <button className="btn btn--primary" onClick={reset}>
                  {t('sceneMv.again')}
                </button>
                <button className="text-action" onClick={() => void remove()} disabled={busy}>
                  {t('sceneMv.delete')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {dialog}
    </section>
  );
}
