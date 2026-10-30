import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { LOCALES } from '../lib/money';
import { formatJst, useSession } from '../lib/session';
import { ErrorNotice } from './common';

/**
 * How long is left, as a sentence (docs/GENERATION_QUEUE_SPEC.md).
 *
 * The range is the server's, taken from the provider's own recent songs.
 * When it had too few to measure (`basis: 'default'`) this gives no number
 * at all rather than print the old constant as if it were known. Under a
 * minute and a half it is seconds; above, whole minutes — the lower bound
 * rounded, the upper rounded up, so 118–155 s reads 2–3, not 1–3.
 */
export function etaText(job: JobView, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const e = job.estimate;
  if (e.delayed) return t('create.job.delayed');
  if (e.basis === 'default') return t('eta.usual');
  if (e.maxSeconds <= 0) return t('eta.almost');
  if (e.maxSeconds < 90) return t('eta.seconds', { min: Math.max(e.minSeconds, 1), max: e.maxSeconds });
  const min = Math.max(1, Math.round(e.minSeconds / 60));
  const max = Math.max(min, Math.ceil(e.maxSeconds / 60));
  return min === max ? t('eta.minute', { n: max }) : t('eta.minutes', { min, max });
}

export function QueueStatus({ job, onUpdate, onCancelled }: {
  job: JobView; onUpdate: (job: JobView) => void; onCancelled: () => void;
}) {
  const { t, lang } = useI18n();
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
      {job.queueDeadlineAt && (
        <p className="small muted">
          {t('create.queue.deadline', {
            time: new Date(job.queueDeadlineAt).toLocaleTimeString(LOCALES[lang], { hour: '2-digit', minute: '2-digit' }),
          })}
        </p>
      )}
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
