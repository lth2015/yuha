import { useEffect, useRef, useState } from 'react';
import { ISSUE_KINDS, ISSUE_NOTE_MAX, type IssueKind, type IssueReportView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { clampToCodePoints } from '../lib/codepoints';
import { useI18n } from '../lib/i18n';
import { formatTime } from '../lib/player';
import { ErrorNotice } from './common';

/**
 * Reporting a problem with this song, privately (docs/ISSUE_REPORTS_SPEC.md).
 *
 * A few taps: what kind of problem, where in the song, a line if wanted, and
 * whether support may listen. Everything else — the job, the timing source,
 * the request id of a failure — the server attaches itself, so the person is
 * never asked for anything only an engineer would know.
 */
export function IssueReport(props: {
  trackId: string;
  /** Where the song is playing now, if it is this song. */
  currentSeconds: number | null;
  /** Set when opened from a failure notice: the kind, and that failure's request id. */
  prefill?: { kind: IssueKind; requestId?: string | null };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<IssueKind | null>(props.prefill?.kind ?? null);
  const [at, setAt] = useState<string>(props.currentSeconds !== null ? String(Math.floor(props.currentSeconds)) : '');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [history, setHistory] = useState<IssueReportView[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    apiFetch<{ items: IssueReportView[] }>(`/v1/tracks/${props.trackId}/issues`)
      .then((r) => setHistory(r.items))
      .catch(() => undefined);
  }, [props.trackId, sent]);

  const submit = async () => {
    if (!kind || busy) return;
    setBusy(true);
    setError(null);
    const seconds = at.trim() === '' ? undefined : Math.max(0, Math.min(600, Math.floor(Number(at))));
    try {
      const res = await apiFetch<IssueReportView>(`/v1/tracks/${props.trackId}/issues`, {
        method: 'POST',
        body: {
          kind,
          ...(seconds !== undefined && Number.isFinite(seconds) ? { atSeconds: seconds } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          audioConsent: consent,
          ...(props.prefill?.requestId ? { requestId: props.prefill.requestId } : {}),
        },
      });
      setSent(res.reportNumber);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="issue-report stack" aria-labelledby="issue-report-title">
      <h2 id="issue-report-title" ref={heading} tabIndex={-1}>
        {t('issue.title')}
      </h2>
      {sent ? (
        <p className="alert alert--ok" role="status">{t('issue.done', { n: sent })}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="composer__presets-row" role="group" aria-labelledby="issue-report-title">
            {ISSUE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`chip chip--btn${kind === k ? ' is-on' : ''}`}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {t(`issue.kind.${k}`)}
              </button>
            ))}
          </div>
          <label htmlFor="issue-at">{t('issue.at')}</label>
          <input
            id="issue-at"
            type="number"
            inputMode="numeric"
            min={0}
            max={600}
            value={at}
            onChange={(e) => setAt(e.target.value)}
            aria-describedby="issue-at-hint"
          />
          <span id="issue-at-hint" className="small muted">{t('issue.atHint')}</span>
          <label htmlFor="issue-note">{t('issue.note')}</label>
          <textarea
            id="issue-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(clampToCodePoints(e.target.value, ISSUE_NOTE_MAX))}
          />
          <label className="issue-report__consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{t('issue.consent')}</span>
          </label>
          <p className="small muted">{t('issue.consentHint')}</p>
          <ErrorNotice error={error} />
          <div className="song-spread__rename-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!kind || busy}>
              {busy ? t('issue.sending') : t('issue.submit')}
            </button>
            <button type="button" className="text-action" onClick={props.onClose} disabled={busy}>
              {t('song.rename.cancel')}
            </button>
          </div>
        </form>
      )}
      {history.length > 0 && (
        <div className="stack issue-report__history">
          <h3>{t('issue.history')}</h3>
          <ul>
            {history.map((r) => (
              <li key={r.reportNumber}>
                <span className="num small">{r.reportNumber}</span> · {t(`issue.kind.${r.kind}`)}
                {r.atSeconds !== null && <> · {formatTime(r.atSeconds)}</>} ·{' '}
                <strong>{t(`issue.status.${r.status}`)}</strong>
                {r.resolution && <p className="small">{r.resolution}</p>}
                {r.compensatedUnits ? <p className="small"><strong>{t('issue.compensated', { n: r.compensatedUnits })}</strong></p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sent && (
        <div>
          <button type="button" className="text-action" onClick={props.onClose}>
            {t('issue.close')}
          </button>
        </div>
      )}
    </section>
  );
}
