import { useEffect, useRef, useState } from 'react';
import type { JobView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { ErrorNotice } from './common';

export function QueueStatus({ job, onUpdate, onCancelled }: {
  job: JobView; onUpdate: (job: JobView) => void; onCancelled: () => void;
}) {
  const { t } = useI18n();
  const { refreshEntitlements } = useSession();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (job.state !== 'QUEUED' || job.queuePosition == null) return null;
  const cancel = async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true); setError(null);
    try {
      const result = await apiFetch<{ cancelled: boolean }>(`/v1/jobs/${job.jobId}/cancel`, { method: 'POST' });
      if (result.cancelled) {
        await refreshEntitlements();
        onCancelled();
      } else {
        onUpdate(await apiFetch<JobView>(`/v1/jobs/${job.jobId}`));
      }
    } catch (err) { setError(err); }
    finally { active.current = false; setBusy(false); }
  };
  return <div className="queue-status">
    <span className="queue-status__orbit" aria-hidden="true" />
    <div className="queue-status__body"><strong role="status">{t('create.queue.position', { position: job.queuePosition })}</strong>
      <p className="small muted">{t('create.queue.note')}</p>
      <button type="button" className="btn btn--small" onClick={() => void cancel()} disabled={busy} aria-busy={busy}>{t('create.queue.cancel')}</button>
      {error ? <ErrorNotice error={error} onRetry={() => void cancel()} /> : null}
    </div>
  </div>;
}

/** Resuming is explicit so returning to the studio never overwrites a draft. */
export function OpenGenerations({ onResume }: { onResume: (job: JobView) => void }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<JobView[]>([]);
  useEffect(() => {
    let gone = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      if (gone || loading || document.hidden) return;
      loading = true;
      try {
        const result = await apiFetch<{ items: JobView[] }>('/v1/jobs');
        if (gone) return;
        setJobs(result.items);
        if (result.items.length) timer = setTimeout(load, 10_000);
      } catch {
        if (!gone) timer = setTimeout(load, 30_000);
      } finally { loading = false; }
    };
    const onVisibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    void load();
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { gone = true; clearTimeout(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  if (!jobs.length) return null;
  return <section className="open-generations card" aria-label={t('create.queue.open')}>
    <h2>{t('create.queue.open')}</h2>
    {jobs.map((job) => <div className="open-generations__row" key={job.jobId}>
      <div><strong>{job.title || job.prompt}</strong><span className="small muted">{job.queuePosition != null
        ? t('create.queue.position', { position: job.queuePosition }) : t(`create.phase.${job.phase}`)}</span></div>
      <button type="button" className="btn btn--small" onClick={() => onResume(job)}>{t('create.queue.resume')}</button>
    </div>)}
  </section>;
}
