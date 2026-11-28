import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { publishLyricSyncUpdate, type LyricSyncUpdate } from '../lib/lyric-sync-refresh';

type Proposal =
  | { status: 'none' | 'running' | 'limit' }
  | { status: 'queued'; ahead: number }
  | { status: 'ready'; id: string; applied?: boolean; canApply?: boolean }
  | { status: 'failed'; failure?: string };

export function LyricAutoSync({ trackId, syncing }: { trackId: string; syncing: boolean }) {
  const { t } = useI18n();
  const url = `/v1/tracks/${trackId}/lyric-proposal`;
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const pending = proposal?.status === 'queued' || proposal?.status === 'running';
  const shouldRead = proposal === null || pending;

  useEffect(() => {
    if (!shouldRead) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let interval = 3000;
    const poll = async () => {
      const next = await apiFetch<Proposal>(url, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) return;
      if (next) {
        setReadFailed(false);
        setProposal(next);
        interval = 3000;
        if (next.status !== 'queued' && next.status !== 'running') return;
      } else {
        setReadFailed(true);
        interval = Math.min(30_000, interval * 2);
      }
      timer = window.setTimeout(() => void poll(), interval);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [url, shouldRead]);

  const retry = async () => {
    setWorking(true);
    setApplyFailed(false);
    try {
      setProposal(await apiFetch<Proposal>(url, { method: 'POST' }));
    } catch (err) {
      setProposal({ status: err instanceof ApiError && err.status === 429 ? 'limit' : 'failed' });
    } finally {
      setWorking(false);
    }
  };

  const apply = async (id: string) => {
    setWorking(true);
    setApplyFailed(false);
    try {
      const update = await apiFetch<LyricSyncUpdate>(`${url}/${id}/apply`, { method: 'POST' });
      publishLyricSyncUpdate(update);
      setProposal({ status: 'ready', id, applied: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setProposal({ status: 'failed', failure: 'stale' });
      } else {
        setApplyFailed(true);
      }
    } finally {
      setWorking(false);
    }
  };

  const ready = proposal?.status === 'ready' && !proposal.applied && proposal.canApply;
  let note = '';
  switch (proposal?.status) {
    case 'queued': note = t('sync.auto.queued', { n: proposal.ahead }); break;
    case 'running': note = t('sync.auto.running'); break;
    case 'ready':
      note = t(proposal.applied ? 'sync.auto.applied' : proposal.canApply ? 'sync.auto.ready' : 'sync.auto.stale');
      break;
    case 'limit': note = t('sync.auto.limit'); break;
    case 'failed':
      note = t(proposal.failure === 'low_coverage' ? 'sync.auto.failed.coverage'
        : proposal.failure === 'stale' ? 'sync.auto.stale' : 'sync.auto.failed.other');
      break;
  }

  if (syncing && !pending && !ready) return null;

  return (
    <div className="lyric-auto-sync">
      {ready ? (
        <button type="button" className="btn btn--sm" onClick={() => void apply(proposal.id)} disabled={working || syncing}>
          {t('sync.auto.apply')}
        </button>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void retry()}
          disabled={proposal === null || pending || working || proposal.status === 'limit'}>
          {t('sync.auto.button')}
        </button>
      )}
      <p className="small muted" role="status">{applyFailed ? t('sync.auto.applyFailed') : readFailed ? t('sync.auto.readFailed') : note}</p>
    </div>
  );
}
