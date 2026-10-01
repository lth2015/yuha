import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNotice } from './common';
import { apiFetch } from '../lib/api';
import { rich, useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';

/**
 * UI-02: the 18+ and terms affirmation, asked rather than assumed.
 *
 * The Google callback used to call `confirmAgeAndTerms` on the user's behalf,
 * so every production account was recorded as having affirmed both without
 * being asked — `POST /v1/me/consent` had no caller anywhere in the web app,
 * and `Account.tsx` showed an age row that could only ever read "confirmed".
 *
 * This is where it is asked. A banner rather than a modal, deliberately: the
 * first thing somebody wants to do when asked to accept terms is read them,
 * and the server already refuses generation and purchase with
 * `AGE_NOT_CONFIRMED` until the answer arrives, so nothing needs blocking in
 * the client to make the gate real.
 */
export function ConsentGate() {
  const { t } = useI18n();
  const { me, refreshMe } = useSession();
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!me || me.ageConfirmed) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!age || !terms || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/me/consent', {
        method: 'POST',
        body: { ageConfirmed: true, termsAccepted: true, marketingOptIn: marketing },
      });
      await refreshMe();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="consent" aria-labelledby="consent-title">
      <h2 id="consent-title" className="consent__title">
        {t('consent.title')}
      </h2>
      <p className="consent__body">{t('consent.body')}</p>
      <ErrorNotice error={error} />
      <form className="stack stack--tight" onSubmit={submit} noValidate>
        <div className="checkbox-row">
          <input id="consent-age" type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
          <label htmlFor="consent-age">{t('auth.age')}</label>
        </div>
        <div className="checkbox-row">
          <input id="consent-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <label htmlFor="consent-terms">
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
        <div className="checkbox-row">
          <input
            id="consent-marketing"
            type="checkbox"
            checked={marketing}
            onChange={(e) => setMarketing(e.target.checked)}
          />
          <label htmlFor="consent-marketing">{t('auth.marketing')}</label>
        </div>
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={!age || !terms || busy}>
            {busy ? t('common.loading') : t('consent.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}
