import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, newIdempotencyKey } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { formatJst } from '../../lib/session';
import { Badge, ErrorNotice } from '../common';

interface RunView {
  id: string;
  idempotencyKey: string;
  status: 'running' | 'done';
  reason: string;
  tracksSeen: number;
  tracksRealigned: number;
  tracksKept: number;
  createdAt: string;
  finishedAt: string | null;
  active: boolean;
}

interface Overview {
  preview: { songs: number; corrected: number; aligner: string; ready: boolean };
  runs: RunView[];
}

/**
 * Lyric re-alignment (docs/LYRIC_ALIGNMENT.md), admin only.
 *
 * Same shape as the credit reset card: what a run would visit is shown before
 * the button, the run happens on the server, this card polls it, and offers
 * to continue one a stopped process left unfinished.
 */
export function LyricRealign() {
  const { t } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<Overview>('/v1/admin/lyric-realignments');
      setData(next);
      const live = next.runs.find((r) => r.status === 'running' && r.active);
      if (poll.current) clearTimeout(poll.current);
      if (live) poll.current = setTimeout(() => void load(), 3000);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [load]);

  if (!data) return error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null;

  const unfinished = data.runs.find((r) => r.status === 'running');

  const run = async (key: string, why: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/admin/lyric-realignments', { method: 'POST', body: { reason: why, idempotencyKey: key } });
      setReason('');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!window.confirm(t('admin.realign.confirm', { songs: String(data.preview.songs) }))) return;
    void run(newIdempotencyKey('realign'), reason.trim());
  };

  return (
    <section className="card stack" style={{ gap: 'var(--s2)' }}>
      <div className="row row--between" style={{ alignItems: 'center' }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.realign.h2')}</h2>
        {unfinished && <Badge tone="badge--warn">{t('admin.realign.running')}</Badge>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.realign.rule')}
      </p>
      <ErrorNotice error={error} />

      {unfinished ? (
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          <p style={{ margin: 0 }}>
            {t('admin.realign.progress', {
              seen: String(unfinished.tracksSeen),
              realigned: String(unfinished.tracksRealigned),
              kept: String(unfinished.tracksKept),
            })}
          </p>
          {!unfinished.active && (
            <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="small muted">{t('admin.realign.stopped')}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void run(unfinished.idempotencyKey, unfinished.reason)}>
                {t('admin.realign.continue')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            {t('admin.realign.preview', { songs: String(data.preview.songs), corrected: String(data.preview.corrected) })}
          </p>
          {!data.preview.ready && (
            <p className="alert alert--warn small" style={{ margin: 0 }}>
              {t('admin.realign.noAligner')}
            </p>
          )}
          <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.sc.reason')}
              aria-label={t('admin.sc.reason')}
              style={{ maxWidth: 420 }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !data.preview.ready || reason.trim().length < 3 || data.preview.songs === 0}
              onClick={start}
            >
              {t('admin.realign.start')}
            </button>
          </div>
        </>
      )}

      {data.runs.length > 0 && (
        <div className="table-wrap table-wrap--stack">
          <table>
            <thead>
              <tr>
                <th>{t('admin.reset.when')}</th>
                <th>{t('admin.reset.reason')}</th>
                <th>{t('admin.realign.h2')}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td className="small">{formatJst(r.createdAt, true)}</td>
                  <td className="small">{r.reason}</td>
                  <td className="num">
                    {t('admin.realign.result', { realigned: String(r.tracksRealigned), kept: String(r.tracksKept) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
