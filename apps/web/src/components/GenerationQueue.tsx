import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, useSession } from '../lib/session';
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
      <button type="button" className="btn btn--sm" onClick={() => void cancel()} disabled={busy} aria-busy={busy}>{t('create.queue.cancel')}</button>
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
      <button type="button" className="btn btn--sm" onClick={() => onResume(job)}>{t('create.queue.resume')}</button>
    </div>)}
  </section>;
}

/**
 * What became of a finished job's credit, as the ledger has it
 * (docs/TASK_RECOVERY_SPEC.md), and the job's full id, which is what support
 * needs to find it. The failure pages used to state "returned" for every
 * failure without asking. The reason (`job.failure.*`) is the page's own
 * subtitle, so it is not repeated here.
 */
export function JobOutcome({ job }: { job: JobView }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(job.jobId).then(() => setCopied(true), () => undefined);
  };
  return <div className="job-outcome">
    <p className="job-outcome__line"><strong>{t(`job.credit.${job.credit}`)}</strong></p>
    <p className="small muted job-outcome__ref">
      {t('job.ref')} <span className="num job-outcome__id">{job.jobId}</span>{' '}
      <button type="button" className="text-action" onClick={copy}>{copied ? t('job.copied') : t('job.copy')}</button>
    </p>
  </div>;
}

/**
 * Jobs that ended without a song, so one that failed while the page was
 * closed can be found again (docs/TASK_RECOVERY_SPEC.md). `withinHours`
 * narrows the server's thirty days for the pages where only a recent one
 * should still be news; the library shows them all.
 */
export function UnfinishedGenerations({ withinHours }: { withinHours?: number }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<JobView[]>([]);
  useEffect(() => {
    let gone = false;
    const load = () => {
      apiFetch<{ items: JobView[] }>('/v1/jobs/unfinished')
        .then((r) => { if (!gone) setJobs(r.items); })
        .catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => { gone = true; window.removeEventListener('focus', load); };
  }, []);
  const since = withinHours ? Date.now() - withinHours * 3600_000 : 0;
  const shown = jobs.filter((job) => new Date(job.updatedAt).getTime() >= since);
  if (!shown.length) return null;
  return <section className="open-generations card" aria-labelledby="unfinished-h">
    <h2 id="unfinished-h">{t('job.unfinished.h2')}</h2>
    {shown.map((job) => <div className="open-generations__row unfinished__row" key={job.jobId}>
      <div>
        <strong>{job.title || job.prompt || t('create.defaultTitle')}</strong>
        <span className="small muted">
          {formatJst(job.updatedAt)} · {job.failure ? t(`job.failure.short.${job.failure}`) : ''} · {t(`job.credit.short.${job.credit}`)}
        </span>
      </div>
      <div className="unfinished__actions">
        <Link className="btn btn--sm" to={`/create?job=${encodeURIComponent(job.jobId)}`}>{t('job.view')}</Link>
        <Link className="btn btn--sm btn--primary" to={`/create?retry=${encodeURIComponent(job.jobId)}`}>{t('job.retry')}</Link>
      </div>
    </div>)}
  </section>;
}
