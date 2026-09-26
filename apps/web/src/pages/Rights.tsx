import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst } from '../lib/session';
import { ErrorNotice } from '../components/common';

/**
 * SEC-10: the rights-complaint entry point.
 *
 * Deliberately public and free — a rights holder is never asked to create an
 * account or pay in order to raise a claim. The confirmation is explicit that a
 * suspension is not a finding of infringement, and that files already
 * downloaded elsewhere cannot be technically recalled.
 */
export default function Rights() {
  const { t } = useI18n();
  const [form, setForm] = useState({
    trackId: '',
    reporterName: '',
    reporterEmail: '',
    claimType: 'copyright' as 'copyright' | 'neighboring_rights' | 'name_or_voice' | 'other',
    description: '',
  });
  const [result, setResult] = useState<{ caseNumber: string; receivedAt: string; notice: string } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ caseNumber: string; receivedAt: string; notice: string }>(
        '/v1/rights-cases',
        {
          method: 'POST',
          body: {
            ...(form.trackId.trim() ? { trackId: form.trackId.trim() } : {}),
            reporterName: form.reporterName,
            reporterEmail: form.reporterEmail,
            claimType: form.claimType,
            description: form.description,
            evidenceUrls: [],
          },
        },
      );
      setResult(res);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div style={{ maxWidth: 620, margin: '0 auto' }} className="stack stack--loose">
        <h1 style={{ fontSize: 26 }}>{t('rights.received.h1')}</h1>
        <section className="panel stack">
          <div className="row row--between">
            <span className="muted">{t('rights.caseNumber')}</span>
            <strong className="num">{result.caseNumber}</strong>
          </div>
          <div className="row row--between">
            <span className="muted">{t('rights.receivedAt')}</span>
            <span>{formatJst(result.receivedAt)}</span>
          </div>
          <hr className="divider" />
          <p className="small" style={{ margin: 0 }}>
            {result.notice}
          </p>
        </section>
        <p className="small muted">
          {t('rights.keepNumber')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }} className="stack stack--loose">
      <div className="stack stack--tight">
        <h1 style={{ fontSize: 26 }}>{t('rights.h1')}</h1>
        <p className="muted">
          {t('rights.intro')}
        </p>
      </div>

      <div className="alert alert--info">
        <div className="alert__title">{t('rights.how.title')}</div>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: '1.2em' }}>
          <li>{t('rights.how.1')}</li>
          <li>{t('rights.how.2')}</li>
          <li>{t('rights.how.3')}</li>
          <li>{t('rights.how.4')}</li>
        </ul>
      </div>

      <ErrorNotice error={error} />

      <form className="panel stack" onSubmit={submit}>
        <div>
          <label htmlFor="claimType">{t('rights.type')}</label>
          <select
            id="claimType"
            value={form.claimType}
            onChange={(e) => setForm({ ...form, claimType: e.target.value as typeof form.claimType })}
          >
            <option value="copyright">{t('rights.type.copyright')}</option>
            <option value="neighboring_rights">{t('rights.type.neighboring')}</option>
            <option value="name_or_voice">{t('rights.type.nameVoice')}</option>
            <option value="other">{t('rights.type.other')}</option>
          </select>
        </div>

        <div>
          <label htmlFor="reporterName">{t('rights.name')}</label>
          <input
            id="reporterName"
            type="text"
            required
            value={form.reporterName}
            onChange={(e) => setForm({ ...form, reporterName: e.target.value })}
          />
        </div>

        <div>
          <label htmlFor="reporterEmail">{t('rights.email')}</label>
          <input
            id="reporterEmail"
            type="email"
            required
            value={form.reporterEmail}
            onChange={(e) => setForm({ ...form, reporterEmail: e.target.value })}
          />
        </div>

        <div>
          <label htmlFor="trackId">{t('rights.trackId')}</label>
          <input
            id="trackId"
            type="text"
            value={form.trackId}
            onChange={(e) => setForm({ ...form, trackId: e.target.value })}
            placeholder={t('rights.trackId.placeholder')}
          />
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {t('rights.trackId.hint')}
          </p>
        </div>

        <div>
          <label htmlFor="description">{t('rights.description')}</label>
          <textarea
            id="description"
            required
            minLength={10}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('rights.description.placeholder')}
          />
        </div>

        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? t('rights.submitting') : t('rights.submit')}
        </button>
        <p className="small muted" style={{ margin: 0 }}>
          {/* A tail key, like `create.pickPlanTail`, because the sentence does not
              end at the link in every language: Japanese puts the verb last, so
              "詳しくは[…]をご覧ください。" needs text *after* it. Splitting on the
              link alone left the ja sentence with no predicate at all. */}
          {t('rights.privacyNote')}
          <Link to="/legal/privacy">{t('rights.privacyPolicy')}</Link>
          {t('rights.privacyTail')}
        </p>
      </form>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('rights.forUsers.h2')}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {t('rights.forUsers.body')}
        </p>
      </section>
    </div>
  );
}
