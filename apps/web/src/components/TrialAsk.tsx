import { useState } from 'react';
import { Link } from 'react-router-dom';
import { rich, useI18n } from '../lib/i18n';

/**
 * The step between "make it" and a song for somebody with no account
 * (docs/GROWTH_SPEC.md, part three): what a trial is, the same two
 * affirmations an account gives (ConsentGate), and one button that does the
 * rest. Signing in instead is always one link away.
 */
export function TrialAsk({ busy, onStart, onCancel }: { busy: boolean; onStart: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  return (
    <section className="trial-ask" aria-labelledby="trial-ask-title">
      <h2 id="trial-ask-title">{t('trial.title')}</h2>
      <p>{t('trial.body')}</p>
      <div className="checkbox-row">
        <input id="trial-age" type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
        <label htmlFor="trial-age">{t('auth.age')}</label>
      </div>
      <div className="checkbox-row">
        <input id="trial-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
        <label htmlFor="trial-terms">
          {rich(t('auth.terms'), {
            terms: (
              <Link to="/legal/terms" target="_blank">
                {t('auth.termsLink')}
              </Link>
            ),
            privacy: (
              <Link to="/legal/privacy" target="_blank">
                {t('auth.privacyLink')}
              </Link>
            ),
          })}
        </label>
      </div>
      <div className="trial-ask__actions">
        <button type="button" className="btn btn--primary" disabled={!age || !terms || busy} aria-busy={busy} onClick={onStart}>
          {busy ? t('composer.submitting') : t('trial.cta')}
        </button>
        <Link className="text-action" to={`/auth?next=${encodeURIComponent('/')}`}>
          {t('trial.signin')}
        </Link>
        <button type="button" className="text-action" onClick={onCancel}>
          {t('photo.close')}
        </button>
      </div>
    </section>
  );
}
