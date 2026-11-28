import { useEffect, useRef, useState } from 'react';
import { canonicalSectionTag, type LyricTimings } from '@yuha/contracts';
import { ApiError, apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';
import './SceneMv.css';

interface SceneMvView {
  id: string;
  trackId: string;
  status: 'draft' | 'queued' | 'generating' | 'composing' | 'ready' | 'failed' | 'cancelled';
  style: string;
  clipStart: number;
  clipEnd: number;
  shots: { idx: number; status: string; prompt?: string }[];
  drawn: number;
  total: number;
  othersInProgress: number;
  failure: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const STYLES = ['neon_rain', 'seaside_sunset', 'soft_watercolor'] as const;
const ongoing = (mv: SceneMvView) => ['queued', 'generating', 'composing'].includes(mv.status);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0').replace(/\.0$/, '')}`;

export function SceneMv({ trackId, title, duration, timings, visible = true, onListen, onVideoPlay }: {
  trackId: string; title: string; duration: number; timings: LyricTimings | null;
  visible?: boolean;
  onListen?: (start: number) => void;
  onVideoPlay?: () => void;
}) {
  const { t, lang } = useI18n();
  const [mv, setMv] = useState<SceneMvView | null>(null);
  const [shots, setShots] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState(Math.min(30, duration));
  const [start, setStart] = useState(() => {
    const chorus = timings?.lines.find((line) => canonicalSectionTag(line.section) === 'chorus');
    return Math.max(0, Math.min(duration - Math.min(30, duration), chorus?.start ?? (duration - Math.min(30, duration)) / 2));
  });
  const [style, setStyle] = useState<(typeof STYLES)[number]>('neon_rain');
  const [description, setDescription] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const listing = useRef<AbortController | null>(null);
  const receive = (item: SceneMvView | null) => {
    setMv(item);
    setShots(item?.status === 'draft' ? item.shots.map((shot) => shot.prompt ?? '') : []);
  };
  useEffect(() => {
    const controller = new AbortController();
    listing.current = controller;
    setError(null);
    void apiFetch<{ items: SceneMvView[] }>(`/v1/tracks/${trackId}/scene-mvs`, { signal: controller.signal })
      .then(({ items }) => {
        if (controller.signal.aborted) return;
        receive(items.find(ongoing) ?? items[0] ?? null);
        setLoaded(true);
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err); });
    return () => controller.abort();
  }, [trackId, reload]);

  useEffect(() => {
    if (!mv || !ongoing(mv) || busy || !visible) return;
    const id = mv.id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const poll = async () => {
      if (document.hidden || reading || controller.signal.aborted) return;
      reading = true;
      try {
        const fresh = await apiFetch<SceneMvView>(`/v1/scene-mvs/${id}`, { signal: controller.signal });
        if (!controller.signal.aborted) { receive(fresh); setError(null); }
      } catch (err) { if (!controller.signal.aborted) setError(err); }
      finally {
        reading = false;
        if (!controller.signal.aborted && !document.hidden) timer = setTimeout(() => void poll(), 12_000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    timer = setTimeout(() => void poll(), 12_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [mv?.id, mv?.status, busy, visible]);

  const cancel = async () => {
    if (!mv || busy) return;
    listing.current?.abort();
    setBusy(true); setError(null);
    try { receive(await apiFetch<SceneMvView>(`/v1/scene-mvs/${mv.id}/cancel`, { method: 'POST' })); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!mv || busy) return;
    listing.current?.abort();
    setBusy(true); setError(null); setActiveId(null);
    try {
      await apiFetch(`/v1/scene-mvs/${mv.id}`, { method: 'PATCH', body: { shots } });
      receive(await apiFetch<SceneMvView>(`/v1/scene-mvs/${mv.id}/start`, { method: 'POST' }));
    } catch (err) {
      const details = err instanceof ApiError ? err.details as { reason?: string; activeId?: string } | undefined : undefined;
      if (details?.reason === 'busy' && details.activeId) setActiveId(details.activeId);
      else {
        setError(err);
        // A lost write response does not prove it failed. Re-read the task,
        // retaining the edited text if it is still a draft.
        try {
          const fresh = await apiFetch<SceneMvView>(`/v1/scene-mvs/${mv.id}`);
          if (fresh.status !== 'draft') { receive(fresh); setError(null); }
        } catch { /* retain the last confirmed task and the visible error */ }
      }
    } finally { setBusy(false); }
  };
  const viewActive = async () => {
    if (!activeId || busy) return;
    setBusy(true); setError(null);
    try {
      const active = await apiFetch<SceneMvView>(`/v1/scene-mvs/${activeId}`);
      if (active.trackId === trackId) { receive(active); setActiveId(null); }
      else setActiveTrackId(active.trackId);
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  const plan = async () => {
    if (busy || !loaded || !(length > 0)) return;
    listing.current?.abort();
    setBusy(true); setError(null);
    try {
      receive(await apiFetch<SceneMvView>(`/v1/tracks/${trackId}/scene-mvs`, {
        method: 'POST', body: { clipStart: start, clipEnd: start + length, style, description },
      }));
    } catch (err) {
      setError(err);
      // Creating a draft may have succeeded before the connection dropped.
      try {
        const { items } = await apiFetch<{ items: SceneMvView[] }>(`/v1/tracks/${trackId}/scene-mvs`);
        if (items[0]) receive(items.find(ongoing) ?? items[0]);
      } catch { /* keep the entered description and visible error */ }
    }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!mv || busy || !window.confirm(t('sceneMv.deleteConfirm'))) return;
    listing.current?.abort();
    setBusy(true); setError(null);
    try { await apiFetch(`/v1/scene-mvs/${mv.id}`, { method: 'DELETE' }); receive(null); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };
  const expired = mv?.expiresAt ? Date.parse(mv.expiresAt) <= Date.now() : false;
  return <section className="scene-mv" aria-labelledby="scene-mv-title">
    <div className="scene-mv__heading"><h3 id="scene-mv-title">{t('sceneMv.title')}</h3><span className="badge">{t('sceneMv.portrait')}</span></div>
    <p className="muted">{t('sceneMv.lead')}</p>
    <ErrorNotice error={error} onRetry={!loaded ? () => setReload((n) => n + 1) : undefined} />
    {activeId && <div className="alert" role="status"><p>{t('sceneMv.busy')}</p>
      {activeTrackId ? <a className="btn" href={`/song/${encodeURIComponent(activeTrackId)}?video=1`}>{t('sceneMv.activeSong')}</a>
        : <button className="btn" disabled={busy} type="button" onClick={() => void viewActive()}>{t('sceneMv.viewActive')}</button>}
    </div>}
    {!loaded && !error && <p role="status">{t('common.loading')}</p>}
    {loaded && !mv && <form className="scene-mv__form" onSubmit={(e) => { e.preventDefault(); void plan(); }}>
      <fieldset disabled={busy}>
        <legend>{t('sceneMv.clip')}</legend>
        <p className="scene-mv__time"><strong>{clock(start)} — {clock(start + length)}</strong><span>{t('sceneMv.seconds', { n: length })}</span></p>
        <label>{t('sceneMv.start')}<input type="range" min="0" max={Math.max(0, duration - length)} step="0.5" value={start} onChange={(e) => setStart(Number(e.target.value))} /></label>
        <label>{t('sceneMv.length')}<input type="range" min={Math.min(1, duration)} max={Math.min(32, duration)} step="0.5" value={length} onChange={(e) => { const n = Number(e.target.value); setLength(n); setStart((s) => Math.min(s, duration - n)); }} /></label>
        {onListen && <button className="btn btn--sm" type="button" onClick={() => onListen(start)}>{t('sceneMv.listen')}</button>}
        {timings?.source === 'estimated' && <p className="small muted">{t('sceneMv.estimated')}</p>}
      </fieldset>
      <fieldset className="scene-mv__styles" disabled={busy}><legend>{t('sceneMv.style')}</legend>
        {STYLES.map((value) => <label key={value} className={`scene-mv__style${style === value ? ' is-selected' : ''}`}>
          <img src={`/scene-mv/${value}.svg`} alt="" width="240" height="160" loading="lazy" />
          <span><input type="radio" name="scene-mv-style" value={value} checked={style === value} onChange={() => setStyle(value)} />{t(`sceneMv.style.${value}`)}</span>
        </label>)}
      </fieldset>
      <p className="small muted">{t('sceneMv.sample')}</p>
      <label>{t('sceneMv.description')}<textarea value={description} maxLength={300} rows={2} disabled={busy} onChange={(e) => setDescription(e.target.value)} /></label>
      <p className="small muted">{t('sceneMv.privacy')}</p>
      <p className="small muted">{t('sceneMv.planNote')}</p>
      <button className="btn btn--primary" type="submit" disabled={busy}>{t(busy ? 'common.loading' : 'sceneMv.plan')}</button>
    </form>}
    {mv?.status === 'draft' && <div className="scene-mv__draft">
      <p>{t('sceneMv.review')}</p>
      <p className="small muted">{clock(mv.clipStart)} — {clock(mv.clipEnd)} · {t(`sceneMv.style.${mv.style}`)}</p>
      <ol className="scene-mv__shots">{shots.map((prompt, i) => <li key={i}><label>{t('sceneMv.shot', { n: i + 1 })}
        <textarea value={prompt} rows={3} maxLength={300} aria-invalid={prompt.length > 300 || !prompt.trim()} disabled={busy} onChange={(e) => setShots((old) => old.map((s, j) => j === i ? e.target.value : s))} />
        <span className="small muted">{t('sceneMv.promptLimit', { n: prompt.length })}</span>
      </label></li>)}</ol>
      <p className="small muted">{t('sceneMv.wait')}</p>
      <p className="small muted">{t('sceneMv.planNote')}</p>
      <button type="button" className="btn btn--primary" onClick={() => void confirm()} disabled={busy || shots.some((s) => !s.trim() || s.length > 300)}>{t(busy ? 'common.loading' : 'sceneMv.confirm')}</button>
      <button className="text-action" type="button" disabled={busy} onClick={() => void remove()}>{t('sceneMv.discard')}</button>
    </div>}
    {mv && ongoing(mv) && <div className="scene-mv__progress" role="status">
      <strong>{t(`sceneMv.${mv.status}`, { n: Math.min(mv.drawn + 1, mv.total), total: mv.total })}</strong>
      <p>{t('sceneMv.drawn', { n: mv.drawn, total: mv.total })}</p>
      <progress value={mv.drawn} max={mv.total} aria-label={t('sceneMv.drawn', { n: mv.drawn, total: mv.total })} />
      {mv.othersInProgress > 0 && <p>{t('sceneMv.others')}</p>}
      <p className="small muted">{t('sceneMv.wait')}</p>
      <p>{t('sceneMv.return')}</p>
      {(mv.status === 'queued' || mv.status === 'generating') && <>
        <p className="small muted">{t('sceneMv.cancelNote')}</p>
        <button className="btn" type="button" disabled={busy} onClick={() => void cancel()}>{t('sceneMv.cancel')}</button>
      </>}
      <button className="text-action" type="button" disabled={busy} onClick={() => setReload((n) => n + 1)}>{t('sceneMv.retryRead')}</button>
    </div>}
    {mv?.status === 'cancelled' && <p role="status">{t('sceneMv.cancelled')}</p>}
    {mv?.status === 'failed' && <div role="status"><p>{t('sceneMv.failed')}</p>
      {['shot_failed', 'compose_failed', 'song_gone', 'timeout'].includes(mv.failure ?? '') && <p>{t(`sceneMv.failure.${mv.failure}`)}</p>}
    </div>}
    {mv?.status === 'ready' && <div className="scene-mv__result">
      <strong>{t('sceneMv.ready')}</strong>
      <p>{expired ? t('sceneMv.expired') : mv.expiresAt && Number.isFinite(Date.parse(mv.expiresAt))
        ? t('sceneMv.expiry', { date: new Date(mv.expiresAt).toLocaleString(lang === 'zh' ? 'zh-CN' : lang) }) : t('sceneMv.expiryUnknown')}</p>
      {!expired && <SceneMvResult key={mv.id} id={mv.id} title={title} visible={visible} onPlay={onVideoPlay} />}
    </div>}
    {mv && ['ready', 'failed', 'cancelled'].includes(mv.status) && <div className="scene-mv__actions">
      <button className="btn" type="button" disabled={busy} onClick={() => { receive(null); setError(null); setActiveId(null); setActiveTrackId(null); }}>{t('sceneMv.again')}</button>
      <button className="text-action" type="button" disabled={busy} onClick={() => void remove()}>{t('sceneMv.delete')}</button>
    </div>}
  </section>;
}

/** Load the file before the Share gesture, so native sharing keeps user activation. */
function SceneMvResult({ id, title, visible, onPlay }: { id: string; title: string; visible: boolean; onPlay?: () => void }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (!visible) videoRef.current?.pause(); }, [visible]);
  useEffect(() => () => reading.current?.abort(), []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const load = async () => {
    if (loading) return;
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    const timer = setTimeout(() => controller.abort(), 60_000);
    setLoading(true); setError(false);
    try {
      const signed = await apiFetch<{ url: string; expiresAt: string }>(`/v1/scene-mvs/${id}/download`, { signal: controller.signal });
      // This signed storage URL must never receive the account's bearer token.
      const response = await fetch(signed.url, { credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('video unavailable');
      const blob = await response.blob();
      // Local signed storage currently labels every non-WAV file audio/mpeg.
      // Check the MP4 container itself; an HTML error with HTTP 200 is not a video.
      if (await blob.slice(4, 8).text() !== 'ftyp') throw new Error('invalid video response');
      if (controller.signal.aborted) return;
      const name = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'yuha'}-scene-mv.mp4`;
      const video = new File([blob], name, { type: 'video/mp4' });
      setFile(video); setUrl(URL.createObjectURL(video));
    } catch { if (reading.current === controller) setError(true); }
    finally { clearTimeout(timer); if (reading.current === controller) setLoading(false); }
  };
  const canShare = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const share = async () => {
    if (!file || !canShare) return;
    try { await navigator.share({ files: [file] }); }
    catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError(true); }
  };
  return <div className="scene-mv__result">
    {error && <p role="alert">{t('sceneMv.previewError')}</p>}
    {url && file && <>
      <video ref={videoRef} className="scene-mv__preview" src={url} controls playsInline preload="metadata" aria-label={t('sceneMv.previewLabel')} onPlay={onPlay} onError={() => setError(true)} />
      <div className="scene-mv__actions">
        {canShare && <button className="btn btn--primary" type="button" onClick={() => void share()}>{t('video.saveOrShare')}</button>}
        <a className="btn" href={url} download={file.name}>{t('video.downloadFile')}</a>
      </div>
      {canShare && <p className="small muted">{t('video.saveHint')}</p>}
    </>}
    {(!url || error) && <button className="btn" type="button" disabled={loading} onClick={() => void load()}>{t(loading ? 'sceneMv.preparing' : 'sceneMv.prepare')}</button>}
  </div>;
}
