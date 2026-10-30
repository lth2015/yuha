import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IssueReportView } from '@yuha/contracts';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { formatTime } from '../../lib/player';
import { formatJst } from '../../lib/session';
import { Badge, ErrorNotice } from '../common';

type Item = IssueReportView & {
  id: string;
  trackId: string;
  trackTitle: string | null;
  trackDeleted: boolean;
  context: Record<string, unknown>;
  userEmail: string;
};

/**
 * Owners' private problem reports (docs/ISSUE_REPORTS_SPEC.md), open first.
 *
 * "Listen" exists only where the owner allowed it, and each listen is
 * audited server-side. The context line is what the server attached when
 * the report was filed, so the first question — which job, which timing
 * source, which failed request — is already answered.
 */
export function IssueQueue() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await apiFetch<{ items: Item[] }>('/v1/admin/issues?status=open')).items);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const listen = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>(`/v1/admin/issues/${id}/audio-url`, { method: 'POST' });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  /** The report being resolved: its note, and whether a credit goes back with it. */
  const [resolving, setResolving] = useState<{ id: string; reason: string; compensate: boolean } | null>(null);

  const resolve = async () => {
    if (!resolving || resolving.reason.trim().length < 5) return;
    const { id } = resolving;
    setBusy(id);
    setError(null);
    try {
      await apiFetch(`/v1/admin/issues/${id}/resolve`, {
        method: 'POST',
        body: { reason: resolving.reason.trim(), compensate: resolving.compensate },
      });
      setResolving(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack">
      <h2 style={{ fontSize: 18 }}>{t('admin.issues.h2')}</h2>
      <ErrorNotice error={error} />
      {items === null ? null : items.length === 0 ? (
        <p className="muted">{t('admin.issues.none')}</p>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((r) => (
            <li key={r.id} className="panel stack" style={{ gap: 'var(--s2)' }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
                <span className="num small">{r.reportNumber}</span>
                <Badge tone="badge--warn">{t(`issue.kind.${r.kind}`)}</Badge>
                {r.atSeconds !== null && <span className="small">{formatTime(r.atSeconds)}</span>}
                <span className="small muted">{formatJst(r.createdAt, false)}</span>
              </div>
              <div className="small">
                {r.trackDeleted ? (
                  <span className="muted">{r.trackTitle ?? r.trackId}（{t('admin.issues.deleted')}）</span>
                ) : (
                  <Link className="issue-queue__song" to={`/song/${r.trackId}`}>{r.trackTitle ?? r.trackId}</Link>
                )}{' '}
                · <span className="muted">{r.userEmail}</span>
              </div>
              {r.note && <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{r.note}</p>}
              <p className="small muted" style={{ margin: 0, fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>
                job {String(r.context['jobId'] ?? '—')} · timing {String(r.context['lyricTimingSource'] ?? '—')}
                {r.context['lyricAligner'] ? ` (${String(r.context['lyricAligner'])})` : ''}
                {r.context['requestId'] ? ` · request ${String(r.context['requestId'])}` : ''}
              </p>
              <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
                {r.audioConsent && !r.trackDeleted ? (
                  <button type="button" className="btn btn--sm" disabled={busy === r.id} onClick={() => void listen(r.id)}>
                    {t('admin.issues.listen')}
                  </button>
                ) : (
                  <span className="small muted">{t('admin.issues.noConsent')}</span>
                )}
                {resolving?.id !== r.id && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={busy === r.id}
                    onClick={() => setResolving({ id: r.id, reason: '', compensate: false })}
                  >
                    {t('admin.issues.resolve')}
                  </button>
                )}
              </div>
              {resolving?.id === r.id && (
                <form
                  className="stack issue-queue__resolve"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void resolve();
                  }}
                >
                  <label htmlFor={`resolve-${r.id}`} className="small">{t('admin.issues.resolvePrompt')}</label>
                  <textarea
                    id={`resolve-${r.id}`}
                    rows={2}
                    maxLength={500}
                    value={resolving.reason}
                    onChange={(e) => setResolving({ ...resolving, reason: e.target.value })}
                  />
                  {/* One credit, against this song's generation; the server refuses a second for the same song. */}
                  <label className="issue-report__consent">
                    <input
                      type="checkbox"
                      checked={resolving.compensate}
                      onChange={(e) => setResolving({ ...resolving, compensate: e.target.checked })}
                    />
                    <span>{t('admin.issues.compensate')}</span>
                  </label>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
                    <button
                      type="submit"
                      className="btn btn--primary btn--sm"
                      disabled={busy === r.id || resolving.reason.trim().length < 5}
                    >
                      {t('admin.issues.resolve')}
                    </button>
                    <button type="button" className="text-action" onClick={() => setResolving(null)}>
                      {t('song.rename.cancel')}
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
